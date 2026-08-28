defmodule QuestEngineering.CoreTest do
  use ExUnit.Case, async: true

  test "has no runtime dependencies beyond Elixir" do
    assert Application.spec(:quest_engineering_core, :applications) == [:kernel, :stdlib, :elixir]
  end
end
