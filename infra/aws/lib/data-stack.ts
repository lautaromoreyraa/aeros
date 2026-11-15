import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/** Where the pipeline's outputs, the raw FIRMS downloads and derived files live. */
export const DATA_LAYOUT = {
  harmonizedPrefix: "harmonized/",
  cellsKey: "harmonized/harmonized_cells.parquet",
  hotspotsKey: "harmonized/hotspots_harmonized.parquet",
  rawFirmsPrefix: "raw/firms/",
  earlyWarningKey: "derived/early_warning.json",
  /** GOES-19 fire pixels of the last scans, rewritten every 10 minutes. */
  goesLatestKey: "derived/goes_latest.json",
  /** What the last alert notification told people; private, never served. */
  alertStateKey: "state/alerts.json",
  /** Which cells the GOES watch already told people about; private too. */
  goesAlertStateKey: "state/goes_alerts.json",
  /** Wind of the next 48 h (`aeros wind`); optional, uploaded by hand or by a job. */
  windKey: "derived/wind.json",
  /** Fire-weather index of the next days (`aeros fire-weather`); optional too. */
  fireWeatherKey: "derived/fire_weather.json",
} as const;

/**
 * Provisioned capacity of the subscriptions table, in units. The always-free
 * allowance is 25 read and 25 write units for the whole account, so this
 * leaves room and, being provisioned, can never turn into a bill.
 */
export const SUBSCRIPTIONS_CAPACITY = { read: 5, write: 5 } as const;

export interface DataStackProps extends StackProps {
  /** Days a raw FIRMS download is kept. */
  readonly rawRetentionDays: number;
}

/**
 * The data bucket outlives every other stack: the harmonized tables take a
 * full pipeline run to rebuild, so it is retained on delete. Storage is kept
 * small on purpose (free plan): raw NRT downloads expire once FIRMS' standard
 * archive replaces them, and overwritten versions go after a week.
 */
export class DataStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly subscriptions: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // Who asked for alerts about which cells. Tiny, so a Scan reads it; kept on
    // delete because people signed up in it. Pending sign-ups carry `ttl` and
    // DynamoDB removes them after their day, at no cost. No point-in-time
    // recovery (billed) and no autoscaling (it creates alarms, which count
    // against the free ten).
    this.subscriptions = new dynamodb.Table(this, "SubscriptionsTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: SUBSCRIPTIONS_CAPACITY.read,
      writeCapacity: SUBSCRIPTIONS_CAPACITY.write,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.bucket = new s3.Bucket(this, "DataBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // SSE-S3: free, unlike a customer-managed KMS key.
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "expire-old-versions",
          // Enough to roll back a bad pipeline run or refresh.
          noncurrentVersionExpiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        {
          id: "expire-raw-firms",
          prefix: DATA_LAYOUT.rawFirmsPrefix,
          expiration: Duration.days(props.rawRetentionDays),
        },
      ],
    });
  }
}
