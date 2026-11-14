import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

export interface BudgetStackProps extends StackProps {
  /** Actual monthly cost, in USD, that triggers the alert. */
  readonly limitUsd: number;
  /** Optional address subscribed to the alert topic, passed with -c at deploy time. */
  readonly email?: string;
}

export const FREE_PLAN_REMINDER = [
  "AWS Free plan: one project Region, no cross-Region features, no Lambda@Edge.",
  "Stay on always-free allowances: Lambda 1M requests and 400k GB-s per month,",
  "CloudFront 1 TB and 10M requests per month, Parameter Store standard tier,",
  "CloudWatch Logs kept 7 days. No API Gateway, Secrets Manager, Route 53 zones,",
  "customer-managed KMS keys, NAT gateways, load balancers, EC2 or VPC Lambdas.",
].join(" ");

/**
 * Cost tripwire: steady use should cost nothing, so any actual spend above
 * the limit means something is wrong. Budgets publish to an SNS topic; the
 * e-mail subscription is optional so no address ever lands in the repository
 * (subscribe from the console, or pass -c aeros:budgetEmail=... on deploy).
 */
export class BudgetStack extends Stack {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: BudgetStackProps) {
    super(scope, id, props);

    this.topic = new sns.Topic(this, "BudgetAlerts", { displayName: "aeros budget alerts" });
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowBudgetsToPublish",
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [this.topic.topicArn],
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    );
    if (props.email) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(props.email));
    }

    new budgets.CfnBudget(this, "MonthlyCost", {
      budget: {
        budgetName: "aeros-monthly-cost",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.limitUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "SNS", address: this.topic.topicArn }],
        },
      ],
    });

    new CfnOutput(this, "FreePlanLimits", { value: FREE_PLAN_REMINDER });
    new CfnOutput(this, "BudgetAlertTopicArn", { value: this.topic.topicArn });
  }
}
