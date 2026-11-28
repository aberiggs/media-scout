# Repository instructions

This is a single-client project. Change in-repo consumers atomically: remove dead
fields, adapters, tests, and documentation. Add compatibility only for a named
real consumer or explicit contractual requirement. Protect persisted user data
and safety; do not preserve dead APIs.

Before staging, keep plans, audits, and work logs in the issue, PR, or local
scratch; do not commit them. Keep the top-level README reader-facing: install,
configure, and use the app safely. Put durable technical details in existing
subsystem references.
