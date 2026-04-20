Provide your solution here:
# High-Availability Trading Platform on AWS

If I were building a Binance-like trading system on AWS, I would keep the scope focused on the parts that really matter for a trading platform: login and session handling, market data, order placement and cancel, matching, wallet/ledger updates, and risk checks. That gives us the core trading flow without trying to cover every feature on day one.

## What I would build

I would split the system into a few clear layers:

- **Edge and API layer**: Route 53, Global Accelerator, CloudFront, WAF, Shield, and API Gateway.
- **Application layer**: EKS running auth, order management, risk, account, and market data services.
- **Trading core**: dedicated matching engine pods on EKS with one partition per symbol group.
- **Streaming layer**: MSK for order, trade, and ledger events.
- **Data layer**: Aurora PostgreSQL for transactional data, DynamoDB for idempotency and fast lookup data, Redis for hot cache, and S3 for audit/history.
- **Async and ops layer**: Lambda, EventBridge, SQS, CloudWatch, X-Ray, and OpenSearch.

## Overview diagram

```text
┌──────────────────────┐
│   Route53 (DNS)      │
└─────────┬────────────┘
          │
┌─────────▼────────────┐
│ Global Accelerator   │
│ Nearest healthy region│
└─────────┬────────────┘
          │
┌─────────▼────────────┐
│ CloudFront + WAF     │
│ + Shield (Edge)      │
└─────────┬────────────┘
          │
┌─────────▼────────────┐
│ API Gateway          │
│ REST + WebSocket API  │
└─────────┬────────────┘
          │
┌─────────▼────────────┐
│ ALB (Internal)       │
└─────────┬────────────┘
          │
┌─────────────────────┬─────────────────────┬─────────────────────┐
│                     │                     │                     │
▼                     ▼                     ▼                     ▼
Auth Service      Order Service       Market Data Service   Risk Service
(EKS)             (EKS)               (EKS)                 (EKS)
│                     │                     │                     │
└──────────┬──────────┴──────────┬──────────┴──────────┬──────────┘
           │                     │                     │
┌──────────▼──────────┐   ┌──────▼──────────┐   ┌──────▼──────────┐
│ ElastiCache (Redis) │   │ Matching Engine │   │ Redis (pub/sub) │
│ Session / cache     │   │ Stateful core   │   │ Market fan-out   │
└──────────┬──────────┘   └──────┬──────────┘   └──────┬──────────┘
           │                     │                     │
┌──────────▼──────────────┐  ┌──▼──────────────┐  ┌───▼────────────┐
│ Aurora PostgreSQL       │  │ MSK (Kafka)     │  │ S3 (history)   │
│ Multi-AZ transactions   │  │ Event streaming │  │ + Athena       │
└─────────────────────────┘  └─────────────────┘  └────────────────┘
```

## Why these services

For the edge, I want users to hit the nearest healthy region fast, so I would use Global Accelerator in front of the app, Route 53 for DNS, and CloudFront + WAF + Shield for protection and caching. API Gateway is a good fit for the public REST APIs because it gives me throttling, auth hooks, and easy scaling without having to build that plumbing myself.

For the application tier, I would use EKS because trading systems usually need more control than a fully managed serverless setup gives you. EKS is a better fit when you care about latency tuning, pod placement, service-to-service communication, and running a matching engine alongside regular microservices. I would still keep the stateless services simple and horizontally scalable.

For the matching engine, I would keep it in memory and partition it by symbol group so the same book always has a single owner. That keeps ordering deterministic, which is important in trading. I would persist every important event to Kafka so the system can recover and replay events if needed.

For the data layer, Aurora PostgreSQL is the main transactional store because balances, trades, and settlement need ACID guarantees. DynamoDB is useful for idempotency keys, request tracking, and fast per-user state that does not need relational joins. Redis is where I would keep hot market data, rate-limit counters, and session data to keep the read path fast. S3 is the cheap long-term store for audits and reports.

## How this meets the target

The target load is 500 requests per second with p99 under 100 ms. That is achievable if I keep the synchronous path short. Most reads should come from cache or read replicas, and most writes should go through a small validation path and then into the matching engine or event stream. I would design for at least 2x headroom so the system can absorb bursts without falling over.

For latency, the main rule is to keep the hot path inside one region and avoid unnecessary cross-region calls. Read APIs should usually stay in the 5-30 ms range when they hit cache. Order placement can stay under 100 ms p99 if the API layer, risk checks, and matching path are kept tight and the slower work is pushed to async consumers.

## High availability and failure handling

I would run everything across 3 AZs in a region. EKS worker nodes, MSK, Aurora, and Redis should all be Multi-AZ so a single AZ failure does not take the platform down.

For regional resilience, I would use an active-active edge setup and an active-warm core. Traffic can go to the nearest healthy region through Global Accelerator, and if a region fails, traffic can shift automatically. I would treat the trading core as region-local, while history, audit, and recovery data replicate asynchronously across regions.

I would also enforce idempotency on order APIs, use dedupe keys on consumers, and keep the matching and trade pipeline event-driven. If something goes wrong, the system should be able to degrade gracefully, for example by pausing a symbol or switching part of the platform into read-only mode instead of failing completely.

## Alternatives I considered

- **ECS/Fargate instead of EKS**: simpler operations, but I would choose EKS because I want more control over latency-sensitive workloads.
- **Kinesis instead of MSK**: Kinesis is simpler to run, but Kafka is a better fit for ordered trading events and replay-heavy workflows.
- **DynamoDB-only instead of Aurora**: it can scale very well, but I still want a relational database for balances, settlement, and reporting.
- **ALB + NGINX only instead of API Gateway**: cheaper in some cases, but API Gateway gives me better request management and policy control at the edge.

## How I would scale it later

At the current target of 500 RPS, I would scale mostly by adding more EKS pods, more Redis capacity, more Kafka partitions, and Aurora read replicas.

When the platform grows to a few thousand RPS, I would split the matching engine by symbol family, separate read and write paths more clearly, and move analytics/search traffic to something like OpenSearch instead of putting that load on the trading database.

At a much larger scale, I would move toward region-specific market clusters, with each region owning its own trading partitions and settlement boundaries. I would also add stricter per-market throttling, admission control, and more game-day testing so failover stays predictable.

## Cost approach

I would keep the always-on, low-latency pieces limited to what really needs to stay hot: matching, streaming, core APIs, and transactional storage. Everything else that is bursty or not latency-critical should be pushed into Lambda or other async processing. I would also use Graviton instances where possible, cache aggressively, and keep old data in S3 instead of expensive primary storage.

## My overall take

This design gives me a trading platform that is fast enough for the stated SLO, resilient across AZs and regions, and still practical to operate. It is not trying to be everything at once, but it covers the core trading path in a way that can grow cleanly as traffic and product scope increase.
