import { type App, type Environment, Tags } from "aws-cdk-lib";
import { ApiStack } from "./api-stack.js";
import { loadConfig } from "./config.js";
import { DataStack } from "./data-stack.js";
import { GithubDeployStack } from "./github-deploy-stack.js";
import { RefreshStack } from "./refresh-stack.js";
import { WebStack } from "./web-stack.js";

export interface AerosStacks {
  data: DataStack;
  web: WebStack;
  api: ApiStack;
  refresh: RefreshStack;
  deploy: GithubDeployStack;
}

/** Builds every stack on `app`. Shared by bin/aeros.ts and the assertion tests. */
export function buildAeros(app: App, env?: Environment): AerosStacks {
  const config = loadConfig(app);
  Tags.of(app).add("project", "aeros");

  const data = new DataStack(app, "AerosData", { env });
  const web = new WebStack(app, "AerosWeb", {
    env,
    domainName: config.webDomainName,
    certificateArn: config.webCertificateArn,
  });
  const api = new ApiStack(app, "AerosApi", {
    env,
    dataBucket: data.bucket,
    allowedOrigins: config.allowedOrigins,
  });
  const refresh = new RefreshStack(app, "AerosRefresh", {
    env,
    dataBucket: data.bucket,
    firmsSecretName: config.firmsSecretName,
    firmsArea: config.firmsArea,
  });
  const deploy = new GithubDeployStack(app, "AerosGithubDeploy", {
    env,
    repository: config.githubRepository,
    deployBranch: config.deployBranch,
    createOidcProvider: config.createGithubOidcProvider,
    webBucket: web.bucket,
    distribution: web.distribution,
  });
  return { data, web, api, refresh, deploy };
}
