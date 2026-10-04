defmodule QuestEngineering.Server.ExecutionShellAuthorityTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Server.ExecutionShellAuthority

  test "complete SBX guest capabilities authorize shell without a host grant" do
    binding = workspace_binding()
    refute binding.allow_unconfined_shell
    assert ExecutionShellAuthority.authorized?(executor("sbx"), binding)
  end

  test "HostNative cannot inherit SBX authority and still requires the host grant" do
    binding = workspace_binding()
    refute ExecutionShellAuthority.authorized?(executor("host_native"), binding)

    assert ExecutionShellAuthority.authorized?(
             executor("host_native"),
             %{binding | allow_unconfined_shell: true}
           )
  end

  test "an incomplete SBX proof fails closed even when the host grant is true" do
    incomplete =
      update_in(executor("sbx"), ["execution_environment", "capabilities"], fn capabilities ->
        Enum.reject(capabilities, &(&1["kind"] == "host_filesystem"))
      end)

    binding = workspace_binding()

    refute ExecutionShellAuthority.authorized?(
             incomplete,
             %{binding | allow_unconfined_shell: true}
           )
  end

  test "legacy executors retain only the explicit host grant" do
    binding = workspace_binding()
    refute ExecutionShellAuthority.authorized?(%{}, binding)
    assert ExecutionShellAuthority.authorized?(%{}, %{binding | allow_unconfined_shell: true})
  end

  defp executor(backend_kind) do
    %{
      "execution_environment" => %{
        "backend_kind" => backend_kind,
        "profile" => %{"id" => "test", "digest" => "sha256:test"},
        "capabilities" => [
          %{"kind" => "filesystem_namespace", "mode" => "isolated"},
          %{"kind" => "host_filesystem", "mode" => "unexposed"},
          %{"kind" => "environment_exec", "mode" => "available"},
          %{"kind" => "pty_launcher", "mode" => "available"}
        ]
      }
    }
  end

  defp workspace_binding, do: %{allow_unconfined_shell: false}
end
