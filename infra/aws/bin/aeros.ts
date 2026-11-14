import { App } from "aws-cdk-lib";
import { buildAeros } from "../lib/aeros-app.js";

const app = new App();
// The account comes from whoever runs cdk (local profile or the OIDC role in
// CI); the Region always comes from the `region` context value.
buildAeros(app, process.env.CDK_DEFAULT_ACCOUNT);
app.synth();
