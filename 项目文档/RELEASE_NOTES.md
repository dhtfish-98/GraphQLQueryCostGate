# GraphQLQueryCostGate 0.1.2

This patch updates the package version and release attribution to dhtfish98. The fixed pre-execution cost policy, test-only weak baseline, GraphQL-JS 17.0.2 dependency, and synthetic HTTP cases are unchanged from 0.1.1.

The local release gate rebuilds the npm package from this exact source commit, runs the paired HTTP experiments, installs the tarball in a separate consumer, checks the package's version and author, and verifies the bundled GraphQL-JS license text. The existing 0.1.1 Release and its asset remain historical and are not overwritten. A 0.1.2 Release requires separate GitHub main/tag CI and downloaded asset verification.

The experiment does not establish a third-party defect, a deployed resource guarantee, or CVP eligibility.
