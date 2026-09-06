defmodule QuestEngineering.Core.ReviewVerdictTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Core.ReviewVerdict

  test "acceptance requires the exact provider-neutral structured status" do
    assert ReviewVerdict.accepted?(%{"status" => "accepted", "findings" => []})
    refute ReviewVerdict.accepted?(%{"status" => "rejected", "findings" => ["fix it"]})
    refute ReviewVerdict.accepted?("PASS")
    refute ReviewVerdict.accepted?(%{"summary" => "accepted"})
    refute ReviewVerdict.accepted?(%{"status" => "PASS"})
  end
end
