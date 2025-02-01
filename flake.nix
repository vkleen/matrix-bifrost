{
  inputs = {
    nixpkgs.url = github:NixOS/nixpkgs/nixos-unstable;
    flake-utils.url = github:numtide/flake-utils;
  };
  outputs = inputs@{ self, nixpkgs, flake-utils, ... }: flake-utils.lib.eachDefaultSystem (system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
    in
    rec {
      packages = {
        matrix-bifrost = pkgs.mkYarnPackage rec {
          pname = "matrix-bifrost";
          version = "develop";
          name = "${pname}-${version}";
          nativeBuildInputs = [ pkgs.makeWrapper ];
          src = self;
          packageJSON = ./package.json;

          offlineCache = pkgs.fetchYarnDeps {
            yarnLock = ./yarn.lock;
            sha256 = "sha256-8dO70wELOd1Lec/jL7CRQzuxkWzvkkC3sD4cqCKGg4Q=";
          };
          packageResolutions = {
            "@matrix-org/matrix-sdk-crypto-nodejs" =
              "${pkgs.matrix-sdk-crypto-nodejs}/lib/node_modules/@matrix-org/matrix-sdk-crypto-nodejs";
          };

          buildPhase = ''
            runHook preBuild
            yarn build
            runHook postBuild
          '';

          postInstall = ''
            makeWrapper '${pkgs.nodejs}/bin/node' "$out/bin/matrix-bifrost" --add-flags \
                "$out/libexec/matrix-bifrost/deps/matrix-bifrost/lib/Program.js"
          '';

          doDist = false;
        };
      };
      defaultPackage = packages.matrix-bifrost;
    });
}
