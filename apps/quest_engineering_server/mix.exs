defmodule QuestEngineering.Server.MixProject do
  use Mix.Project

  def project do
    [
      app: :quest_engineering_server,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.20",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      test_coverage: [tool: ExCoveralls, summary: [threshold: 0]],
      deps: deps(),
      listeners: [Phoenix.CodeReloader]
    ]
  end

  def application do
    [
      mod: {QuestEngineering.Server.Application, []},
      extra_applications: [:logger, :runtime_tools]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_env), do: ["lib"]

  defp deps do
    [
      {:quest_engineering_core, in_umbrella: true},
      {:phoenix, "~> 1.8.13"},
      {:phoenix_ecto, "~> 4.7.0"},
      {:ecto_sql, "~> 3.14.0"},
      {:postgrex, "~> 0.22.4"},
      {:jason, "~> 1.4.5"},
      {:bandit, "~> 1.12.5"}
    ]
  end
end
