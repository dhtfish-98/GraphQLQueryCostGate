# Source and attribution

The application code in `src/` and the synthetic schema/tests were independently written for this local project by **dhtfish98**. No source files or algorithms were copied from the studied upstream repository.

Defensive research reference: `slicknode/graphql-query-complexity`, pinned commit [`31a4e10868585290ef81197170ab3c57aca773ad`](https://github.com/slicknode/graphql-query-complexity/commit/31a4e10868585290ef81197170ab3c57aca773ad). The upstream project is MIT licensed; its [license at that commit](https://github.com/slicknode/graphql-query-complexity/blob/31a4e10868585290ef81197170ab3c57aca773ad/LICENSE) carries Copyright (c) 2017 Ivo Meißner. This link is a research citation, not a claim of upstream code reuse or an upstream vulnerability.

Runtime dependency: GraphQL-JS `graphql@17.0.2`, MIT licensed by GraphQL Contributors. Its [versioned license](https://github.com/graphql/graphql-js/blob/v17.0.2/LICENSE) and the exact license text distributed with the installed package are retained as `GRAPHQL_JS_LICENSE`; see `THIRD_PARTY_NOTICES.md`. The package is installed separately under `Build` during local verification.

GraphQL's [security guidance](https://graphql.org/learn/security/) discusses aliases, paginated fields, depth and query complexity as demand-control concerns. The lab's weak baseline is intentionally created here; it is not evidence of exploitation of any third-party service.
