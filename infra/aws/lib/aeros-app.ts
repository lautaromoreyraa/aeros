import { type App, Tags } from "aws-cdk-lib";
import { BudgetStack } from "./budget-stack.js";
import { loadConfig } from "./config.js";
import { DataStack } from "./data-stack.js";
import { GithubDeployStack } from "./github-deploy-stack.js";
import { RefreshStack } from "./refresh-stack.js";
import { WebStack } from "./web-stack.js";

export interface AerosStacks {
  data: DataStack;
  web: WebStack;
  refresh: RefreshStack;
  budget: BudgetStack;
  deploy: GithubDeployStack;
}

/**
 * Builds every stack on `app`, all in the one Region the context names (the
 * free plan's project Region). Shared by bin/aeros.ts and the assertion tests.
 */
export function buildAeros(app: App, account?: string): AerosStacks {
  const config = loadConfig(app);
  const env = { account, region: config.region };
  Tags.of(app).add("project", "aeros");

  const data = new DataStack(app, "AerosData", { env, rawRetentionDays: config.rawRetentionDays });
  const web = new WebStack(app, "AerosWeb", {
    env,
    dataBucket: data.bucket,
    apiReservedConcurrency: config.apiReservedConcurrency,
    domainName: config.webDomainName,
    certificateArn: config.webCertificateArn,
  });
  const refresh = new RefreshStack(app, "AerosRefresh", {
    env,
    dataBucket: data.bucket,
    firmsMapKeyParameter: config.firmsMapKeyParameter,
    firmsArea: config.firmsArea,
    reservedConcurrency: config.refreshReservedConcurrency,
    webUrl: config.webUrl,
    alertRegionName: config.alertRegionName,
    alertEmailIdentity: config.alertEmailIdentity,
  });
  const budget = new BudgetStack(app, "AerosBudget", {
    env,
    limitUsd: config.budgetLimitUsd,
    email: config.budgetEmail,
  });
  const deploy = new GithubDeployStack(app, "AerosGithubDeploy", {
    env,
    repository: config.githubRepository,
    deployBranch: config.deployBranch,
    createOidcProvider: config.createGithubOidcProvider,
    webBucket: web.bucket,
    distribution: web.distribution,
  });
  return { data, web, refresh, budget, deploy };
}
