[
  import_deps: [:ecto_sql],
  inputs: ["*.exs"],
  # This migration is already applied and must remain byte-identical.
  excludes: ["20260916000000_separate_discovery_and_execution_authorization.exs"]
]
