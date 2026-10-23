# Distributed systems glossary

## Latency
Latency is the time it takes for a request or message to travel through a system and get a response. Lower latency usually means the system feels faster to a person using it.
Example: A webpage that appears in 200 milliseconds has lower latency than one that takes two seconds.

## Throughput
Throughput is how much work a system can complete in a given amount of time. It is often measured in requests, messages, or transactions per second.
Example: A service that handles 500 requests each second has a throughput of 500 requests per second.

## Idempotency
Idempotency means that repeating the same operation has the same effect as doing it once. This helps prevent duplicate work when a request is retried after a timeout or connection problem.
Example: Sending the same payment request twice with the same idempotency key charges the customer only once.

## Backpressure
TODO: definition and example

## Circuit breaker
TODO: definition and example

## Eventual consistency
TODO: definition and example