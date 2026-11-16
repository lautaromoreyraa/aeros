# Aeros System Architecture & Engineering Reference

Aeros is an open, auditable planetary wildfire anticipation and early-warning platform. Built on 26 years of NASA satellite observations (MODIS and VIIRS), it eliminates historical sensor transition artifacts, models multi-horizon fire danger, and dispatches localized alerts to rural communities and emergency responders before flames reach settlements.

---

## 1. End-to-End System Architecture

The end-to-end data lifecycle spans remote-sensing ingestion, equal-area spatial harmonization, statistical anomaly scoring, machine-learning risk projection, serverless cloud routing, and multi-tier notification dispatch.

```mermaid
flowchart TB
  subgraph ingestion["1. Observation & Environmental Data Ingestion"]
    direction TB
    FIRMS["NASA FIRMS<br/>26-Year MODIS Terra/Aqua (1000m)<br/>VIIRS SNPP/NOAA-20/21 (375m)"]
    GOES["NOAA GOES-19 ABI<br/>L2 Fire Detection (ABI-L2-FDCF)<br/>10-minute cadence"]
    METEO["Weather & Fuel Dryness<br/>Open-Meteo ERA5 Reanalysis<br/>NASA POWER Surface Meteorology"]
  end

  subgraph analytics["2. Core Harmonization & Forecasting Engine"]
    direction TB
    H3["Discrete Global Grid System<br/>Uber H3 Spatial Resampling (Res 5–7)<br/>Equal-area hexagon aggregation"]
    CALIB["Sensor Neutralization<br/>Corrects +230% artificial sensor shift<br/>26-year baseline distributions"]
    POISSON["Statistical Anomaly Detector<br/>Poisson Tail Probability (p < 0.01)<br/>Flags counts > 2x historical median"]
    GBM["ML Predictive Forecaster<br/>Gradient Boosting (scikit-learn)<br/>1–4 week ahead fire risk projection"]
  end

  subgraph cloud["3. Serverless Cloud Infrastructure (AWS Free-Tier Compliant)"]
    direction TB
    EB["Amazon EventBridge<br/>Automated 10-minute triggers"]
    LAMBDA["AWS Lambda (arm64, 512MB)<br/>Stateless execution & proximity matching"]
    DDB["Amazon DynamoDB<br/>Single-table subscriber store<br/>Geodesic 15km radius filtering"]
    S3CF["Amazon S3 + CloudFront<br/>Global edge cache & static hosting"]
  end

  subgraph dispatch["4. Multichannel Warning Delivery Matrix"]
    direction TB
    SMS["SMS Gateway (Twilio / httpSMS)<br/>160-char high-urgency message<br/>Zero-data & low-connectivity rural zones"]
    TG["Telegram Bot Service<br/>Interactive alerts with coordinates,<br/>wind heading, and risk level cards"]
    SES["Amazon SES Email<br/>Full operational situational report<br/>for land managers and civil defense"]
  end

  subgraph frontend["5. Interactive 3D Digital Twin & Dashboard"]
    direction TB
    TWIN["3D Planetary Globe (Three.js 4K)<br/>Terrain Map (MapLibre GL)<br/>Wind vector overlays & cell drilldown"]
  end

  FIRMS --> H3
  H3 --> CALIB
  CALIB --> POISSON
  METEO & CALIB --> GBM
  GOES --> LAMBDA
  POISSON & GBM --> LAMBDA
  EB --> LAMBDA
  LAMBDA <--> DDB
  LAMBDA --> SMS & TG & SES
  CALIB & GBM & GOES --> S3CF
  S3CF --> TWIN
```

---

## 2. Sensor Harmonization Pipeline

### The Sensor Transition Problem
NASA FIRMS has tracked global hotspots with MODIS on Terra and Aqua since 2000 at a 1 km spatial resolution. In 2012, VIIRS on Suomi-NPP introduced a finer 375 m imaging channel, followed by NOAA-20 and NOAA-21.

Because VIIRS has ~7 times higher pixel density per unit area, raw active fire counts jump by approximately **+230%** simply from instrument changes. Uncorrected datasets mislead climate models and public response agencies by mistaking sensor evolution for wildfire intensification.

```mermaid
flowchart LR
  subgraph raw["Raw Satellite Hotspot Archives"]
    M1["MODIS (2000–present)<br/>1000m resolution<br/>Fewer detections per fire cluster"]
    V1["VIIRS (2012–present)<br/>375m resolution<br/>~2.3x higher hotspot count"]
  end

  subgraph naive["Naive Analysis (Flawed)"]
    BIAS["Artificial +230% Spike<br/>Distorts multi-decadal trends<br/>Triggers false alarms"]
  end

  subgraph aeros["Aeros Harmonization Engine"]
    GRID["H3 Hexagonal Indexing<br/>Equal-area discrete binning"]
    CAL["Quantile & Ratio Alignment<br/>Normalizes sensor detection curves"]
    NORM["Harmonized Anomaly Baseline<br/>Consistent 2000–present baseline"]
  end

  M1 & V1 --> BIAS
  M1 & V1 --> GRID --> CAL --> NORM
```

### Aeros Resolution Strategy
1. **H3 Discrete Global Grid System**: Projects hotspot coordinates onto equal-area hexagonal cells (resolution 5 to 7), eliminating projection distortion across latitude ranges.
2. **Empirical Quantile Calibration**: Maps VIIRS detection densities to MODIS-equivalent activity scales using overlapping temporal observations (2012–present).
3. **Location-Agnostic Model**: No geographic identifiers are used as predictive features, ensuring the harmonization methodology transfers universally across ecoregions.

---

## 3. Anticipation Mechanisms

Aeros replaces generative speculation with three auditable, verifiable analytical engines operating across distinct time horizons:

| Horizon | Mechanism | Implementation | Role |
|---|---|---|---|
| **1–4 Weeks** | Gradient Boosting Regressor | `model/src/aeros/forecast.py` | Predicts regional fire pressure using ERA5 weather (2m temperature, relative humidity, wind vectors) and NASA POWER fuel dryness. |
| **Daily Baseline** | Poisson Tail Anomaly Test | `infra/aws/lambdas/refresh/early_warning.py` | Flags when current 7-day activity exceeds $2\times$ historical median with Poisson probability $p < 0.01$. |
| **10 Minutes** | Real-Time Geostationary Watch | `infra/aws/lambdas/refresh/goes_watch.py` | Ingests NOAA GOES-19 ABI Level-2 fire products (ABI-L2-FDCF) for immediate detection. |

```mermaid
sequenceDiagram
  autonumber
  actor Environment as Wildfire Conditions
  participant Sat as GOES-19 / FIRMS
  participant Lambda as Refresh Lambda
  participant Engine as Poisson & GBM Engines
  participant DDB as DynamoDB Subscriptions
  participant Router as Dispatch Matrix (SMS / TG / SES)
  actor User as Citizen / Firefighter

  Environment->>Sat: Active fire radiative power (MW)
  Sat->>Lambda: 10-minute ABI feed / FIRMS update
  Lambda->>Engine: Run Poisson test & 15km proximity filter
  Engine-->>Lambda: Anomaly confirmed (p < 0.01)
  Lambda->>DDB: Query subscribed users within geodesic radius
  DDB-->>Lambda: Target subscriber list & preferred channel
  Lambda->>Router: Dispatch customized warning payload
  Router->>User: Low-bandwidth SMS, Telegram card, or Email
```

---

## 4. Multi-Channel Alert Dispatch Protocol

Wildfire emergencies predominantly affect rural or remote territories where cellular data connectivity is often compromised. Aeros provides a tiered dispatch protocol that routes alerts according to subscriber bandwidth and operational needs.

```mermaid
flowchart TD
  TRIGGER["Real-Time Anomaly Trigger<br/>GOES-19 hotspot or Poisson p < 0.01"] --> COORD["Extract Event Centroid & Radiative Power (MW)"]
  COORD --> QUERY["Query DynamoDB Subscriptions"]
  QUERY --> GEO{"Geodesic Distance &le; 15 km?"}
  GEO -- "No" --> DISCARD["Suppress (Prevent alert fatigue)"]
  GEO -- "Yes" --> ROUTE{"Selected Delivery Channel"}

  ROUTE -- "SMS" --> C_SMS["SMS Gateway (Twilio / httpSMS)<br/>160-char text optimized for low connectivity<br/>Works without internet or data coverage"]
  ROUTE -- "Telegram" --> C_TG["Telegram Bot (@AerosAlertBot)<br/>Rich card with coordinates, wind vector,<br/>and emergency checklist"]
  ROUTE -- "Email" --> C_EMAIL["Amazon SES Email<br/>Full briefing with meteorological context,<br/>historical comparison, and response checklist"]

  C_SMS --> RECV1["Rural Residents & Field Volunteer Crews"]
  C_TG --> RECV2["Local Brigades & Command Coordinators"]
  C_EMAIL --> RECV3["Civil Defense & Environmental Authorities"]
```

---

## 5. AWS Cloud Infrastructure & Free-Tier Guardrails

All backend operations are strictly architected to operate within the AWS Free Tier and Always-Free allowances:

```mermaid
flowchart LR
  subgraph compute["Stateless Compute"]
    L1["AWS Lambda arm64<br/>512MB RAM, timeout &le; 60s<br/>Unreserved concurrency"]
  end

  subgraph storage["Operational Data Store"]
    D1["Amazon DynamoDB<br/>Single-table architecture<br/>5 RCU / 5 WCU provisioned"]
  end

  subgraph edge["Edge Delivery"]
    S1["Amazon S3 Static Assets"]
    CF1["Amazon CloudFront CDN<br/>Edge caching & Function URLs"]
  end

  subgraph monitors["Operational Safety"]
    CW1["AWS Budgets ($1 alert)<br/>CloudWatch Alarms (&le; 10 alarms)<br/>7-day log retention"]
  end

  L1 <--> D1
  S1 --> CF1
  CF1 --> L1
  L1 -.-> CW1
```

* **No Container Gateways**: AWS Lambda Function URLs with CloudFront origin shields eliminate API Gateway overhead.
* **No NAT Gateways or VPCs**: Stateless Lambda functions access AWS service endpoints directly.
* **Single-Table DynamoDB**: Efficient partition indexing on geohash / locality prevents secondary index charges.
* **Deterministic Budgets**: CDK synthesis tests (`infra/aws/test/free-tier.test.ts`) assert template compliance before merge.

---

## 6. Verification and Auditability

The entire codebase is validated across every pull request via `.github/workflows/verify.yml`:
* **Pipeline & Model**: `cd model && ruff check . && python -m pytest -q`
* **Web UI & 3D Twin**: `cd web && npm ci && npm test && npm run build`
* **Infrastructure**: `cd infra/aws && npm ci && npm run build && npm test && npx cdk synth --quiet`
* **Team Server**: `cd infra/mcp && npm ci && npx tsc --noEmit && npx vitest run`
