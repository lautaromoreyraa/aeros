import { App } from "aws-cdk-lib";
import { buildAeros } from "../lib/aeros-app.js";

const app = new App();
// The account comes from whoever runs cdk (local profile or the OIDC role in
// CI). The region defaults to us-east-1, where CloudFront certificates live.
buildAeros(app, {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
});
app.synth();
