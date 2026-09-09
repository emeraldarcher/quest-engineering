defmodule QuestEngineering.Core.DocumentArtifact do
  @moduledoc """
  Generic immutable text-document artifact convention.

  The semantic artifact kind remains open (for example `quest_plan` or
  `architecture_spec`). Document values use a small JSON-compatible envelope;
  Worker-local materialization paths are deliberately not part of this model.
  """

  @max_content_bytes 1_048_576
  @markdown_kinds ~w(quest_plan requirements_spec architecture_spec test_plan migration_plan design_document)

  @type metadata :: %{
          content_hash: String.t(),
          media_type: String.t(),
          filename: String.t(),
          title: String.t()
        }

  @spec normalize(String.t(), term()) :: {:ok, term(), metadata() | nil} | {:error, atom()}
  def normalize(type, value) when is_binary(type) do
    if document_value?(type, value), do: normalize_document(type, value), else: {:ok, value, nil}
  end

  @spec document?(term()) :: boolean()
  def document?(%{"kind" => "document", "content" => content}) when is_binary(content), do: true
  def document?(_), do: false

  @spec content(term()) :: String.t() | nil
  def content(%{"kind" => "document", "content" => content}) when is_binary(content), do: content
  def content(_), do: nil

  @spec max_content_bytes() :: pos_integer()
  def max_content_bytes, do: @max_content_bytes

  defp document_value?(type, value),
    do: type in @markdown_kinds or match?(%{"kind" => "document"}, value)

  defp normalize_document(type, value) do
    with {:ok, content, supplied} <- document_fields(value),
         :ok <- validate_content(content),
         {:ok, media_type} <- media_type(Map.get(supplied, "media_type", "text/markdown")),
         filename <- safe_filename(Map.get(supplied, "filename"), type, media_type),
         title <- title(Map.get(supplied, "title"), type),
         hash <- sha256(content) do
      envelope = %{
        "kind" => "document",
        "semantic_kind" => type,
        "media_type" => media_type,
        "filename" => filename,
        "title" => title,
        "content" => content,
        "content_hash" => hash
      }

      {:ok, envelope,
       %{content_hash: hash, media_type: media_type, filename: filename, title: title}}
    end
  end

  defp document_fields(value) when is_binary(value), do: {:ok, value, %{}}

  defp document_fields(%{"content" => content} = value) when is_binary(content),
    do: {:ok, content, value}

  defp document_fields(_), do: {:error, :invalid_document}

  defp validate_content(content) do
    cond do
      not String.valid?(content) -> {:error, :invalid_document_encoding}
      byte_size(content) > @max_content_bytes -> {:error, :document_too_large}
      true -> :ok
    end
  end

  defp media_type(value) when value in ["text/markdown", "text/plain"], do: {:ok, value}
  defp media_type(_), do: {:error, :unsupported_document_media_type}

  defp safe_filename(value, type, media_type) do
    extension = if media_type == "text/markdown", do: ".md", else: ".txt"
    fallback = String.replace(type, "_", "-") <> extension

    case value do
      filename when is_binary(filename) ->
        basename = Path.basename(filename)

        if basename == filename and basename not in ["", ".", ".."] and
             String.match?(basename, ~r/\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z/),
           do: basename,
           else: fallback

      _ ->
        fallback
    end
  end

  defp title(value, _type) when is_binary(value) and value != "", do: String.slice(value, 0, 160)

  defp title(_value, type) do
    type
    |> String.replace("_", " ")
    |> String.split()
    |> Enum.map_join(" ", &String.capitalize/1)
  end

  defp sha256(content),
    do: "sha256:" <> (:sha256 |> :crypto.hash(content) |> Base.encode16(case: :lower))
end
