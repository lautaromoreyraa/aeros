import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import type * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

const GITHUB_ISSUER = "token.actions.githubusercontent.com";

export interface GithubDeployStackProps extends StackProps {
  /** "owner/name": no other repository can assume the role. */
  readonly repository: string;
  readonly deployBranch: string;
  /** An account holds one provider per issuer; reuse it when it exists. */
  readonly createOidcProvider: boolean;
  readonly webBucket: s3.IBucket;
  readonly distribution: cloudfront.IDistribution;
}

/**
 * Role that GitHub Actions assumes with OIDC, so the repository holds no AWS
 * keys. It does not get broad permissions of its own: `cdk deploy` works by
 * assuming the roles `cdk bootstrap` created, and the web upload only touches
 * the web bucket and its distribution.
 */
export class GithubDeployStack extends Stack {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GithubDeployStackProps) {
    super(scope, id, props);

    const providerArn = props.createOidcProvider
      ? new iam.OpenIdConnectProvider(this, "GithubOidc", {
          url: `https://${GITHUB_ISSUER}`,
          clientIds: ["sts.amazonaws.com"],
        }).openIdConnectProviderArn
      : `arn:${this.partition}:iam::${this.account}:oidc-provider/${GITHUB_ISSUER}`;

    const repo = `repo:${props.repository}`;
    this.role = new iam.Role(this, "DeployRole", {
      description: `GitHub Actions deploy role for ${props.repository}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { [`${GITHUB_ISSUER}:aud`]: "sts.amazonaws.com" },
        // Only the deploy branch, or a job bound to the production
        // environment (which GitHub can gate with reviewers), of this repo.
        StringLike: {
          [`${GITHUB_ISSUER}:sub`]: [
            `${repo}:ref:refs/heads/${props.deployBranch}`,
            `${repo}:environment:production`,
          ],
        },
      }),
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*`],
        conditions: {
          StringEquals: {
            "iam:ResourceTag/aws-cdk:bootstrap-role": [
              "deploy",
              "file-publishing",
              "image-publishing",
              "lookup",
            ],
          },
        },
      }),
    );

    props.webBucket.grantReadWrite(this.role);
    props.webBucket.grantDelete(this.role);
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvalidateWebDistribution",
        actions: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
        resources: [
          `arn:${this.partition}:cloudfront::${this.account}:distribution/${props.distribution.distributionId}`,
        ],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", { value: this.role.roleArn });
  }
}
