defmodule QuestEngineering.Server.ExecutionShellAuthority do
  @moduledoc """
  Resolves `terminal.shell` against execution-environment authority.

  `allow_unconfined_shell` is a host-root grant. An SBX executor instead earns
  shell authority from its isolated guest execution capabilities; the host
  grant neither enables nor repairs an incomplete SBX capability set.
  """

  @isolated_guest_requirements [
    {"filesystem_namespace", "isolated"},
    {"host_filesystem", "unexposed"},
    {"environment_exec", "available"},
    {"pty_launcher", "available"}
  ]

  @spec authorized?(map(), map() | struct()) :: boolean()
  def authorized?(executor, binding) when is_map(executor) do
    case Map.get(executor, "execution_environment") do
      nil ->
        host_granted?(binding)

      %{"backend_kind" => "host_native"} ->
        host_granted?(binding)

      %{"backend_kind" => "sbx", "capabilities" => capabilities}
      when is_list(capabilities) ->
        isolated_guest_capabilities?(capabilities)

      _other ->
        false
    end
  end

  def authorized?(_executor, _binding), do: false

  defp isolated_guest_capabilities?(capabilities) do
    Enum.all?(@isolated_guest_requirements, fn {kind, mode} ->
      Enum.any?(capabilities, fn
        %{"kind" => ^kind, "mode" => ^mode} -> true
        _other -> false
      end)
    end)
  end

  defp host_granted?(binding) when is_struct(binding),
    do: Map.get(binding, :allow_unconfined_shell) == true

  defp host_granted?(binding) when is_map(binding) do
    Map.get(binding, :allow_unconfined_shell, Map.get(binding, "allow_unconfined_shell")) == true
  end

  defp host_granted?(_binding), do: false
end
