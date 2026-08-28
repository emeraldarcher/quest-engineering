defmodule QuestEngineering.Core.MixProject do
  use Mix.Project

  def project do
    [
      app: :quest_engineering_core,
      version: "0.5.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.20",
      start_permanent: Mix.env() == :prod,
      test_coverage: [tool: ExCoveralls, summary: [threshold: 0]],
      deps: []
    ]
  end
end
