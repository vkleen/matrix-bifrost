{
  inputs = {
    nixpkgs.url = github:NixOS/nixpkgs;
    flake-utils.url = github:numtide/flake-utils;
  };
  outputs = inputs@{ self, nixpkgs, flake-utils, ... }: flake-utils.lib.eachDefaultSystem (system: let
    pkgs = nixpkgs.legacyPackages.${system};
  in rec {
    packages = {
      matrix-bifrost = pkgs.mkYarnPackage rec {
        pname = "matrix-bifrost";
        version = "develop";
        name = "${pname}-${version}";
        nativeBuildInputs = [ pkgs.makeWrapper ];
        src = self;
        packageJSON = src + "/package.json";
        yarnNix = src + "/yarn.nix";
        buildPhase = ''
          yarn --offline build
        '';
        preInstall = ''
          mkdir -p $out/bin $out/node_modules $out/config
          cp -r node_modules/node-purple $out/node_modules/node-purple
          cp -r deps/matrix-bifrost/lib $out/lib
          cp deps/matrix-bifrost/package.json deps/matrix-bifrost/yarn.lock $out
          cp deps/matrix-bifrost/config/config.schema.yaml $out/config/
          cat > $out/bin/matrix-bifrost <<EOF
          #!${pkgs.stdenv.shell}
          exec ${pkgs.nodejs}/bin/node $out/lib/Program.js "\$@"
          EOF
          chmod +x $out/bin/matrix-bifrost
          wrapProgram $out/bin/matrix-bifrost \
            --set NODE_PATH "$out/libexec/matrix-bifrost/node_modules"
        '';
        distPhase = ":";
        publishBinsFor = [ "matrix-bifrost" ];
      };
    };
    defaultPackage = packages.matrix-bifrost;
  });
}
