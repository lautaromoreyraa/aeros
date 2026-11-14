import { App, type Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { type AerosStacks, buildAeros } from "../lib/aeros-app.js";

/**
 * What the deployed infrastructure may use, checked against the AWS Free plan
 * and the always-free allowances. The limits are the ones AWS publishes:
 *
 * - Lambda: 1,000,000 requests and 400,000 GB-seconds a month.
 * - DynamoDB: 25 provisioned read and 25 write units, 25 GB.
 * - CloudWatch: 10 alarms.
 * - Free plan: ends after 6 months or when its credits run out, then the
 *   account must be upgraded (the budget alert and the runbook say so).
 *
 * A new account also cannot reserve Lambda concurrency, has no SES free tier
 * (the sandbox and the credits cover the few messages sent) and cannot use
 * Organizations, GuardDuty or IAM Identity Center, so none of them appears.
 */

const LAMBDA_REQUESTS = 1_000_000;
const LAMBDA_GB_SECONDS = 400_000;
const DYNAMO_UNITS = 25;
const ALARMS = 10;
const DAY = 30; // a month, rounded up

const CONTEXT = {
  region: "sa-east-1",
  "aeros:githubRepository": "lautaromoreyraa/aeros",
  "aeros:deployBranch": "main",
  "aeros:firmsMapKeyParameter": "/aeros/firms/map-key",
  "aeros:firmsArea": "-69,-35,-53,-16",
  "aeros:createGithubOidcProvider": true,
  "aeros:webUrl": "https://aeros.example.org",
  "aeros:alertRegionName": "Test region",
  "aws:cdk:bundling-stacks": [],
};

let stacks: AerosStacks;
let all: Array<[Stack, Template]>;

function resources(template: Template): Array<[string, { Type: string; Properties?: any }]> {
  return Object.entries(template.toJSON().Resources ?? {}) as any;
}

function ofType(type: string): Array<{ stack: string; id: string; properties: any }> {
  return all.flatMap(([stack, template]) =>
    resources(template)
      .filter(([, r]) => r.Type === type)
      .map(([id, r]) => ({ stack: stack.stackName, id, properties: r.Properties ?? {} })),
  );
}

/** How many times a schedule fires in a month, for the two forms the stacks use. */
function runsPerMonth(expression: string): number {
  const rate = /^rate\((\d+) (minute|minutes|hour|hours|day|days)\)$/.exec(expression);
  if (rate) {
    const unit = rate[2]!.startsWith("minute") ? 1 : rate[2]!.startsWith("hour") ? 60 : 1440;
    return Math.ceil((DAY * 1440) / (Number(rate[1]) * unit));
  }
  // cron(min hour * * ? *): once a day when minute and hour are fixed.
  if (/^cron\(\d+ \d+ \* \* \? \*\)$/.test(expression)) return DAY;
  throw new Error(`the guard cannot count the runs of ${expression}: teach it this form`);
}

beforeAll(() => {
  stacks = buildAeros(new App({ context: CONTEXT }), "111111111111");
  all = Object.values(stacks).map((s: Stack) => [s, Template.fromStack(s)]);
});

describe("AWS Free plan: what may be deployed", () => {
  const BILLED_OR_UNAVAILABLE = [
    /^AWS::RDS::/,
    /^AWS::ElastiCache::/,
    /^AWS::OpenSearch/,
    /^AWS::Elasticsearch::/,
    /^AWS::Kinesis/,
    /^AWS::MSK::/,
    /^AWS::Redshift/,
    /^AWS::EKS::/,
    /^AWS::ECS::/,
    /^AWS::EFS::/,
    /^AWS::WAFv2::/, // the CloudFront flat-rate plan is the only free route to WAF
    /^AWS::Organizations::/,
    /^AWS::GuardDuty::/,
    /^AWS::SSO::/,
    /^AWS::CloudWatch::Dashboard$/, // the always-free three are better spent by hand
    /^AWS::Config::/,
    /^AWS::Backup::/,
    /^AWS::EC2::(Instance|NatGateway|EIP|Volume|VPC|VPCEndpoint)$/,
  ];

  it("uses no service that is billed from the first request or unavailable to the account", () => {
    const found = all.flatMap(([stack, template]) =>
      resources(template)
        .filter(([, r]) => BILLED_OR_UNAVAILABLE.some((re) => re.test(r.Type)))
        .map(([id, r]) => `${stack.stackName}/${id}: ${r.Type}`),
    );
    expect(found).toEqual([]);
  });

  it("keeps every DynamoDB table provisioned, and the total inside the allowance", () => {
    let read = 0;
    let write = 0;
    for (const { id, properties } of ofType("AWS::DynamoDB::Table")) {
      expect(properties.BillingMode, id).not.toBe("PAY_PER_REQUEST");
      expect(properties.GlobalSecondaryIndexes, id).toBeUndefined();
      read += properties.ProvisionedThroughput.ReadCapacityUnits;
      write += properties.ProvisionedThroughput.WriteCapacityUnits;
    }
    expect(read).toBeLessThanOrEqual(DYNAMO_UNITS);
    expect(write).toBeLessThanOrEqual(DYNAMO_UNITS);
  });

  it("creates no more CloudWatch alarms than the free allowance", () => {
    expect(ofType("AWS::CloudWatch::Alarm").length).toBeLessThanOrEqual(ALARMS);
  });

  it("runs only small, short functions", () => {
    for (const { id, properties } of ofType("AWS::Lambda::Function")) {
      expect(properties.MemorySize ?? 128, id).toBeLessThanOrEqual(512);
      expect(properties.Timeout ?? 3, id).toBeLessThanOrEqual(300);
      expect(properties.Architectures, id).toEqual(["arm64"]); // cheaper per GB-second
      expect(properties.ReservedConcurrentExecutions, id).toBeUndefined();
    }
  });

  it("keeps the scheduled functions, at their timeouts, inside the Lambda allowance", () => {
    const refresh = Template.fromStack(stacks.refresh);
    const functions = refresh.findResources("AWS::Lambda::Function");
    let requests = 0;
    let gbSeconds = 0;
    for (const rule of Object.values(refresh.findResources("AWS::Events::Rule")) as any[]) {
      const runs = runsPerMonth(rule.Properties.ScheduleExpression);
      for (const target of rule.Properties.Targets) {
        const fn = (functions as any)[target.Arn["Fn::GetAtt"][0]];
        const gb = (fn.Properties.MemorySize ?? 128) / 1024;
        requests += runs * (1 + 2); // a daily run may be retried twice
        gbSeconds += runs * fn.Properties.Timeout * gb; // every run lasting its whole timeout
      }
    }
    // Worst case, before any visitor: at most 3/4 of the GB-seconds are spent
    // by the schedules, so the API and the bot always have room.
    expect(requests).toBeLessThanOrEqual(LAMBDA_REQUESTS * 0.25);
    expect(gbSeconds).toBeLessThanOrEqual(LAMBDA_GB_SECONDS * 0.75);
  });

  it("alerts on any actual spending, because the Free plan is not unlimited", () => {
    Template.fromStack(stacks.budget).hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { BudgetLimit: { Amount: 1, Unit: "USD" } },
    });
  });
});
