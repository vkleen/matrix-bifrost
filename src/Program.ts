import { Cli, Bridge, AppServiceRegistration, ClientFactory, Logging } from "matrix-appservice-bridge";
import { MatrixEventHandler } from "./MatrixEventHandler";
import { MatrixRoomHandler } from "./MatrixRoomHandler";
import { PurpleProtocol } from "./purple/PurpleProtocol";
import { IPurpleInstance } from "./purple/IPurpleInstance";
import { EventEmitter } from "events";
import { IReceivedImMsg, IAccountEvent } from "./purple/PurpleEvents";
import { ProfileSync } from "./ProfileSync";
import { IEventRequest } from "./MatrixTypes";
import { RoomSync } from "./RoomSync";
import { Store } from "./Store";
import { Deduplicator } from "./Deduplicator";
import { Config, IBridgeBotAccount } from "./Config";
import { Util } from "./Util";
import { XmppJsInstance } from "./xmppjs/XJSInstance";
import { Metrics } from "./Metrics";
import { AutoRegistration } from "./AutoRegistration";
import { GatewayHandler } from "./GatewayHandler";

const log = Logging.get("Program");

/**
 * This is the entry point for the bridge. It contains
 */
class Program {
    private cli: Cli;
    private bridge: Bridge;
    private eventHandler: MatrixEventHandler|undefined;
    private roomHandler: MatrixRoomHandler|undefined;
    private gatewayHandler!: GatewayHandler;
    private profileSync: ProfileSync|undefined;
    private roomSync: RoomSync|undefined;
    private purple?: IPurpleInstance;
    private store: Store|undefined;
    private cfg: Config;
    private deduplicator: Deduplicator;

    constructor() {
        this.cli = new Cli({
          bridgeConfig: {
            affectsRegistration: true,
            schema: "./config/config.schema.yaml",
          },
          registrationPath: "purple-registration.yaml",
          generateRegistration: this.generateRegistration,
          run: this.runBridge.bind(this),
        });
        this.cfg = new Config();
        this.deduplicator = new Deduplicator();
        // For testing w/o libpurple.
        // this.purple = new MockPurpleInstance();
        // setTimeout(() => {
        //     (this.purple as MockPurpleInstance).emit("received-im-msg", {
        //         sender: "testacc@localhost/",
        //         message: "test",
        //         account: null,
        //     } as IReceivedImMsg);
        // }, 5000);
    }

    public get config(): Config {
        return this.cfg;
    }

    public start(): any {
        Logging.configure({console: "debug"});

        try {
            this.cli.run();
        } catch (ex) {
            log.error(ex);
        }
    }

    private generateRegistration(reg, callback) {
      reg.setId(AppServiceRegistration.generateToken());
      reg.setHomeserverToken(AppServiceRegistration.generateToken());
      reg.setAppServiceToken(AppServiceRegistration.generateToken());
      reg.setSenderLocalpart("_purple_bot");
      reg.addRegexPattern("users", "@_purple_.*", true);
      reg.addRegexPattern("aliases", "#_purple_.*", true);
      callback(reg);
    }

    private async runBridge(port: number, config: any) {
        log.info("Starting purple bridge on port", port);
        this.cfg.ApplyConfig(config);
        Logging.configure(this.cfg.logging);
        this.bridge = new Bridge({
          controller: {
            // onUserQuery: userQuery,
            onAliasQuery: (alias, aliasLocalpart) => this.eventHandler!.onAliasQuery(alias, aliasLocalpart),
            onEvent: (request: IEventRequest, context) => {
                if (this.eventHandler === undefined) {return; }
                const p = this.eventHandler.onEvent(request, context).catch((err) => {
                    log.error("onEvent err", err);
                }).catch(() => {
                    Metrics.requestOutcome(false, request.getDuration(), "fail");
                }).then(() => {
                    Metrics.requestOutcome(false, request.getDuration(), "success");
                });
            },
            onAliasQueried: (alias, roomId) => this.eventHandler!.onAliasQueried(alias, roomId),
            // We don't handle these just yet.
            // thirdPartyLookup: this.thirdpa.ThirdPartyLookup,
          },
          domain: this.cfg.bridge.domain,
          homeserverUrl: this.cfg.bridge.homeserverUrl,
          registration: this.cli.getRegistrationFilePath(),
          roomStore: this.cfg.bridge.roomStoreFile,
          userStore: this.cfg.bridge.userStoreFile,
        });
        await this.bridge.run(port, this.cfg);

        if (this.cfg.purple.backend === "node-purple") {
            log.info("Selecting node-purple as a backend");
            this.purple = new (require("./purple/PurpleInstance").PurpleInstance)(this.cfg.purple);
        } else if (this.cfg.purple.backend === "xmpp.js") {
            log.info("Selecting xmpp.js as a backend");
            this.purple = new (require("./xmppjs/XJSInstance").XmppJsInstance)(this.cfg);
        } else {
            throw new Error(`Backend ${this.cfg.purple.backend} not supported`);
        }

        const purple = this.purple!;

        if (this.cfg.metrics.enable) {
            log.info("Enabling metrics");
            Metrics.init(this.bridge);
        }
        this.store = new Store(this.bridge);
        this.profileSync = new ProfileSync(this.bridge, this.cfg, this.store);
        this.roomHandler = new MatrixRoomHandler(
            this.purple!, this.profileSync, this.store, this.cfg, this.deduplicator,
        );
        this.gatewayHandler = new GatewayHandler(purple, this.bridge, this.cfg.bridge, this.store, this.profileSync);
        this.roomSync = new RoomSync(purple, this.store, this.deduplicator, this.gatewayHandler);
        this.eventHandler = new MatrixEventHandler(
            purple, this.store, this.deduplicator, this.config, this.gatewayHandler,
        );
        let autoReg: AutoRegistration|undefined;
        if (this.config.autoRegistration.enabled && this.config.autoRegistration.protocolSteps !== undefined) {
            autoReg = new AutoRegistration(
                this.config.autoRegistration,
                this.bridge,
                this.store,
                purple,
            );
        }

        this.eventHandler.setBridge(this.bridge, autoReg || undefined);
        this.roomHandler.setBridge(this.bridge);
        log.info("Bridge has started.");
        await this.roomSync.sync(this.bridge.getBot(), this.bridge.getIntent());
        try {
            if (purple instanceof XmppJsInstance) {
                purple.preStart(this.bridge, autoReg);
            }
            await purple.start();
            if (purple instanceof XmppJsInstance) {
                purple.signInAccounts(
                    await this.store.getUsernameMxidForProtocol(purple.getProtocols()[0]),
                );
            }
        } catch (ex) {
            log.error("Encountered an error starting the backend:", ex);
            process.exit(1);
        }
        this.purple!.on("account-signed-on", (ev: IAccountEvent) => {
            log.info(`${ev.account.protocol_id}://${ev.account.username} signed on`);
        });
        this.purple!.on("account-connection-error", (ev: IAccountEvent) => {
            log.warn(`${ev.account.protocol_id}://${ev.account.username} had a connection error`, ev);
        });
        this.purple!.on("account-signed-off", (ev: IAccountEvent) => {
            log.info(`${ev.account.protocol_id}://${ev.account.username} signed off.`);
            this.deduplicator.removeChosenOneFromAllRooms(
                Util.createRemoteId(ev.account.protocol_id, ev.account.username),
            );
        });
        log.info("Initiation of bridge complete");
        // await this.runBotAccounts(this.cfg.bridgeBot.accounts);
    }

    private async runBotAccounts(accounts: IBridgeBotAccount[]) {
        // Fetch accounts from config
        accounts.forEach((account) => {
            const acct = this.purple!.getAccount(account.name, account.protocol);
            if (!acct) {
                log.error(
`${account.protocol}:${account.name} is not configured in libpurple. Ensure that accounts.xml is correct.`,
                );
                throw Error("Fatal error while setting up bot accounts");
            }
            if (acct.isEnabled === false) {
                log.error(
`${account.protocol}:${account.name} is not enabled, enabling.`,
                );
                acct.setEnabled(true);
                // Here we should really wait for the account to come online signal.
            }
        });

        // Check they all exist and start.
        // If one is missing from the purple config, fail.
    }
}

new Program().start();
