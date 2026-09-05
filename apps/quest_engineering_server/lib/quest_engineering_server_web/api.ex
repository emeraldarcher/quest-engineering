defmodule QuestEngineering.ServerWeb.Api do
  @moduledoc false
  import Plug.Conn
  import Phoenix.Controller

  alias Ecto.Changeset
  alias QuestEngineering.Core.CompileError
  alias QuestEngineering.Core.Product.TacticPreview.Error, as: PreviewError
  alias QuestEngineering.Server.Product.StarterCrew
  alias QuestEngineering.Server.ProductApi.Service.Error, as: RequestError

  def include_archived?(conn) do
    case conn.params["include_archived"] do
      nil -> {:ok, false}
      "true" -> {:ok, true}
      "false" -> {:ok, false}
      _ -> {:error, %RequestError{code: :invalid_query, details: %{path: ["include_archived"]}}}
    end
  end

  def render_error(conn, error) do
    {status, code, message, details, meta} = error_view(error)

    conn
    |> put_status(status)
    |> json(%{error: %{code: code, message: message, details: details, meta: meta}})
  end

  defp error_view(%StarterCrew.Error{code: :conflict} = error),
    do:
      {409, "starter_conflict", "Starter setup conflicts with existing Product configuration.",
       [], %{entity_type: Atom.to_string(error.entity_type), key: error.key}}

  defp error_view(%StarterCrew.Error{code: :manual_configuration}),
    do:
      {409, "starter_manual_configuration",
       "Manual Product configuration already exists; starter setup was not changed.", [], %{}}

  defp error_view(%StarterCrew.Error{code: :no_compatible_execution_option}),
    do:
      {409, "starter_precondition",
       "No currently available execution configuration can create this starter crew.", [], %{}}

  defp error_view(%StarterCrew.Error{code: :invalid_request, details: details}),
    do: {400, "malformed_request", "The request body is malformed.", [], details}

  defp error_view(%RequestError{code: :archived_reference, details: details}),
    do:
      {409, "archived_reference", "The request references an archived Product definition.", [],
       safe(details)}

  defp error_view(%RequestError{} = error),
    do: {400, "malformed_request", "The request body is malformed.", [], error.details}

  defp error_view(%PreviewError{} = error) do
    details = Enum.map(error.errors, &detail(&1, error.step_origins))
    meta = %{stage: Atom.to_string(error.stage), step_origins: origin_meta(error.step_origins)}

    if Enum.any?(details, &(&1.code == "archived_tactic_definition")) do
      {409, "archived_reference", "The request references an archived Product definition.",
       details, meta}
    else
      {422, "preview_failed", "The tactic could not be previewed.", details, meta}
    end
  end

  defp error_view(%{code: :not_found}),
    do: {404, "not_found", "The requested resource was not found.", [], %{}}

  defp error_view(%{code: :archived_reference, details: details}),
    do:
      {409, "archived_reference", "The request references an archived Product definition.", [],
       safe(details)}

  defp error_view(%{type: :run_not_found}),
    do: {404, "not_found", "The requested resource was not found.", [], %{}}

  defp error_view(:not_found),
    do: {404, "not_found", "The requested resource was not found.", [], %{}}

  defp error_view(%{code: :execution_not_uncertain, details: details}),
    do:
      {409, "execution_not_uncertain", "The selected Step is no longer uncertain.", [],
       safe(details)}

  defp error_view(%{code: :invalid_execution_recovery, details: details}),
    do:
      {400, "malformed_request", "The execution recovery request is malformed.", [],
       safe(details)}

  defp error_view(code)
       when code in [
              :delivery_not_retryable,
              :workspace_not_retained,
              :unmerged_acknowledgement_required,
              :cleanup_not_safe,
              :background_service_not_running
            ] do
    {409, to_string(code), "The request conflicts with current Run delivery state.", [], %{}}
  end

  defp error_view(%Changeset{} = changeset),
    do: {422, "validation_failed", "The request is invalid.", changeset_details(changeset), %{}}

  defp error_view(errors) when is_list(errors) do
    details = Enum.map(errors, &detail/1)

    if Enum.any?(details, &(&1.code == "immutable_key")),
      do: {409, "conflict", "The request conflicts with existing Product state.", details, %{}},
      else: {422, "validation_failed", "The request is invalid.", details, %{}}
  end

  defp error_view(%{code: code, details: details})
       when code in [:immutable_key, :constraint_failure],
       do:
         {409, "conflict", "The request conflicts with existing Product state.",
          [detail(%{code: code, details: details})], %{}}

  defp error_view(%{code: code, details: details}) do
    {422, "launch_failed", "The requested operation could not be completed.",
     [detail(%{code: code, details: details})], %{}}
  end

  defp error_view(_), do: {500, "internal_error", "An unexpected server error occurred.", [], %{}}

  defp changeset_details(changeset) do
    Changeset.traverse_errors(changeset, fn {message, _} -> message end)
    |> Enum.map(fn {field, messages} ->
      %{code: "invalid_value", path: [to_string(field)], details: %{messages: messages}}
    end)
  end

  defp detail(%CompileError{} = error, origins) do
    semantic =
      %{}
      |> maybe(:artifact_type, error.artifact_type)
      |> maybe(:consumer_step, semantic_step(error.step, origins))
      |> maybe(:referenced_step, semantic_step(error.referenced_step, origins))
      |> maybe(:requested_source, semantic_step(error.referenced_source, origins))
      |> maybe(:candidate_steps, semantic_steps(error.candidate_sources, origins))
      |> maybe(:reason, semantic_reason(error.details))

    %{code: to_string(error.type), path: [], details: semantic}
  end

  defp detail(value, _origins), do: detail(value)

  defp semantic_reason(value) when is_atom(value), do: Atom.to_string(value)
  defp semantic_reason(value), do: safe(value)

  defp semantic_steps(nil, _origins), do: nil

  defp semantic_steps(values, origins) when is_list(values) do
    values
    |> Enum.filter(&is_binary/1)
    |> Enum.map(&semantic_step(&1, origins))
  end

  defp semantic_steps(_values, _origins), do: nil

  defp semantic_step(nil, _origins), do: nil

  defp semantic_step(key, origins) when is_binary(key) do
    case Map.get(origins, key) do
      nil ->
        %{local_key: key, instance_path: []}

      origin ->
        %{
          local_key: origin.local_step_key,
          instance_path: origin.instance_path,
          definition_key: origin.definition_key
        }
    end
  end

  defp detail(%{code: code} = value) do
    %{
      code: to_string(code),
      path: Map.get(value, :path, []),
      details: safe(Map.get(value, :details, %{}))
    }
    |> maybe(:instance_path, Map.get(value, :instance_path))
    |> maybe(:definition_path, Map.get(value, :definition_path))
  end

  defp detail(%{type: type, details: details}),
    do: %{code: to_string(type), path: [], details: safe(details)}

  defp detail(value), do: %{code: "invalid_value", path: [], details: %{value: inspect(value)}}

  defp origin_meta(origins),
    do:
      Enum.map(origins, fn {_key, value} ->
        %{
          local_step_key: value.local_step_key,
          instance_path: value.instance_path,
          authoring_path: value.body_path
        }
      end)

  defp maybe(map, _key, nil), do: map
  defp maybe(map, key, value), do: Map.put(map, key, value)

  defp safe(value)
       when is_map(value) or is_list(value) or is_binary(value) or is_number(value) or
              is_boolean(value) or is_nil(value),
       do: value

  defp safe(_), do: %{}
end
