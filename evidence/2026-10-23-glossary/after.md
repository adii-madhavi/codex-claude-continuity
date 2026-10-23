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
Backpressure is a way for a busy part of a system to tell the parts sending it work to slow down. Instead of accepting more than it can handle and crashing, it pushes the pressure back toward the sender.
Example: A message queue that is nearly full tells producers to pause sending until consumers catch up.

## Circuit breaker
A circuit breaker stops a service from repeatedly calling another service that keeps failing. After too many errors it "opens" and fails requests right away, then later lets a few test requests through to see if the other service has recovered.
Example: If a payment service times out five times in a row, the checkout service stops calling it for 30 seconds and shows a "try again later" message instead.

## Eventual consistency
Eventual consistency means that copies of data stored in different places may briefly disagree, but they will all end up the same if no new changes are made. The system chooses to stay fast and available instead of making every copy match instantly.
Example: After you change your profile picture, a friend in another country might still see the old one for a few seconds before the update reaches their nearby server.