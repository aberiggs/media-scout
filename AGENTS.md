# Repository instructions

This is a single-client project. Change in-repo consumers atomically: remove dead
fields, adapters, tests, and documentation. Add compatibility only for a named
real consumer or explicit contractual requirement. Protect persisted user data
and safety; do not preserve dead APIs.
