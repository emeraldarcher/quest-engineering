defmodule QuestEngineering.ServerWeb.Api do
  @moduledoc false
  import Plug.Conn
  import Phoenix.Controller

  alias Ecto.Changeset
  alias QuestEngineering.Core.Product.TacticPreview.Error, as: PreviewError
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

  defp error_view(%RequestError{code: :archived_reference, details: details}),
    do:
      {409, "archived_reference", "The request references an archived Product definition.", [],
       safe(details)}

  defp error_view(%RequestError{} = error),
    do: {400, "malformed_request", "The request body is malformed.", [], error.details}

  defp error_view(%PreviewError{} = error) do
    details = Enum.map(error.errors, &detail/1)
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
      Enum.map(origins, fn {key, value} ->
        %{
          semantic_step_key: key,
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
