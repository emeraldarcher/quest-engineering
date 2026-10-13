defmodule QuestEngineering.Server.ProviderAccountSetupInteractions do
  @moduledoc "Ephemeral, process-bound relay for sensitive ProviderAccount setup bytes."
  use GenServer

  @ttl_seconds 300
  @input_ttl_ms 30_000
  @prune_interval_ms 1_000
  @maximum_output_bytes 16_384
  @input_table __MODULE__.Inputs

  def start_link(options), do: GenServer.start_link(__MODULE__, options, name: __MODULE__)

  @doc "Creates or returns the ephemeral public key for one authorized setup attempt."
  def open(attempt_id, setup_generation) do
    GenServer.call(__MODULE__, {:open, attempt_id, setup_generation})
  end

  @doc "Test-only/plain-memory insertion; production Worker output uses `decrypt_and_put/5`."
  def put(attempt_id, setup_generation, attention_id, process_generation, output)
      when is_binary(output) do
    GenServer.call(
      __MODULE__,
      {:put, attempt_id, setup_generation, attention_id, process_generation, output}
    )
  end

  def decrypt_and_put(
        attempt_id,
        setup_generation,
        attention_id,
        process_generation,
        envelope
      ) do
    GenServer.call(
      __MODULE__,
      {:decrypt_and_put, attempt_id, setup_generation, attention_id, process_generation, envelope}
    )
  end

  def fetch(attempt_id, setup_generation, attention_id, process_generation) do
    GenServer.call(
      __MODULE__,
      {:fetch, attempt_id, setup_generation, attention_id, process_generation}
    )
  end

  def clear(attempt_id), do: GenServer.call(__MODULE__, {:clear, attempt_id})

  def hold_input(value) do
    reference = Base.url_encode64(:crypto.strong_rand_bytes(24), padding: false)
    expires_at = System.monotonic_time(:millisecond) + @input_ttl_ms
    true = :ets.insert(@input_table, {reference, value, expires_at})
    reference
  end

  def take_input(reference) when is_binary(reference) do
    case :ets.take(@input_table, reference) do
      [{^reference, value, expires_at}] ->
        if expires_at > System.monotonic_time(:millisecond), do: {:ok, value}, else: :error

      [] ->
        :error
    end
  end

  def take_input(_reference), do: :error

  @doc "Seals Product-memory output to one local client's ephemeral RSA public key."
  def seal_for_client(output, encoded_public_key) when is_binary(output) do
    with {:ok, public_key} <- decode_public_key(encoded_public_key) do
      key = :crypto.strong_rand_bytes(32)
      iv = :crypto.strong_rand_bytes(12)

      {ciphertext, tag} =
        :crypto.crypto_one_time_aead(:aes_256_gcm, key, iv, output, "", 16, true)

      encrypted_key =
        :public_key.encrypt_public(key, public_key,
          rsa_pad: :rsa_pkcs1_oaep_padding,
          rsa_oaep_md: :sha256
        )

      {:ok,
       %{
         version: "rsa-oaep-sha256-aes-256-gcm-v1",
         encrypted_key: Base.encode64(encrypted_key),
         iv: Base.encode64(iv),
         ciphertext: Base.encode64(ciphertext),
         tag: Base.encode64(tag)
       }}
    end
  rescue
    _error -> {:error, :setup_interaction_encryption_failed}
  end

  @impl true
  def init(_options) do
    :ets.new(@input_table, [
      :named_table,
      :public,
      read_concurrency: true,
      write_concurrency: true
    ])

    schedule_prune()
    {:ok, %{}}
  end

  @impl true
  def handle_call({:open, attempt_id, setup_generation}, _from, state) do
    state = prune(state)

    case Map.get(state, attempt_id) do
      %{setup_generation: ^setup_generation, public_key: public_key} = entry ->
        {:reply, {:ok, public_key}, Map.put(state, attempt_id, refresh(entry))}

      _ ->
        {public_key, private_key} = generate_key_pair()

        entry = %{
          setup_generation: setup_generation,
          public_key: public_key,
          private_key: private_key,
          attention_id: nil,
          process_generation: nil,
          output: nil,
          expires_at: expires_at()
        }

        {:reply, {:ok, public_key}, Map.put(state, attempt_id, entry)}
    end
  end

  def handle_call(
        {:put, attempt_id, setup_generation, attention_id, process_generation, output},
        _from,
        state
      ) do
    entry = %{
      setup_generation: setup_generation,
      public_key: nil,
      private_key: nil,
      attention_id: attention_id,
      process_generation: process_generation,
      output: bounded_output(output),
      expires_at: expires_at()
    }

    {:reply, :ok, Map.put(prune(state), attempt_id, entry)}
  end

  def handle_call(
        {:decrypt_and_put, attempt_id, setup_generation, attention_id, process_generation,
         envelope},
        _from,
        state
      ) do
    state = prune(state)

    case Map.get(state, attempt_id) do
      %{
        setup_generation: ^setup_generation,
        private_key: private_key
      } = entry
      when not is_nil(private_key) ->
        case decrypt(envelope, private_key) do
          {:ok, output} ->
            updated = %{
              entry
              | attention_id: attention_id,
                process_generation: process_generation,
                output: bounded_output(output),
                expires_at: expires_at()
            }

            {:reply, :ok, Map.put(state, attempt_id, updated)}

          :error ->
            {:reply, {:error, :setup_interaction_decryption_failed}, state}
        end

      _ ->
        {:reply, {:error, :setup_interaction_key_unavailable}, state}
    end
  end

  def handle_call(
        {:fetch, attempt_id, setup_generation, attention_id, process_generation},
        _from,
        state
      ) do
    state = prune(state)

    reply =
      case Map.get(state, attempt_id) do
        %{
          setup_generation: ^setup_generation,
          attention_id: ^attention_id,
          process_generation: ^process_generation,
          output: output
        } = entry
        when is_binary(output) ->
          {:ok, Map.take(entry, [:output, :expires_at])}

        _ ->
          {:error, :setup_interaction_unavailable}
      end

    {:reply, reply, state}
  end

  def handle_call({:clear, attempt_id}, _from, state),
    do: {:reply, :ok, Map.delete(state, attempt_id)}

  @impl true
  def handle_info(:prune, state) do
    prune_inputs()
    schedule_prune()
    {:noreply, prune(state)}
  end

  @impl true
  def format_status(_status), do: %{state: :redacted}

  defp decode_public_key(value) when is_binary(value) and byte_size(value) <= 1_024 do
    with {:ok, der} <- Base.decode64(value),
         true <- byte_size(der) in 128..1_024,
         pem =
           :public_key.pem_encode([
             {:SubjectPublicKeyInfo, der, :not_encrypted}
           ]),
         [entry] <- :public_key.pem_decode(pem),
         {:RSAPublicKey, _, _} = public_key <- :public_key.pem_entry_decode(entry) do
      {:ok, public_key}
    else
      _ -> {:error, :setup_interaction_encryption_failed}
    end
  rescue
    _error -> {:error, :setup_interaction_encryption_failed}
  end

  defp decode_public_key(_value), do: {:error, :setup_interaction_encryption_failed}

  defp generate_key_pair do
    private_key = :public_key.generate_key({:rsa, 2048, 65_537})
    public_key = {:RSAPublicKey, elem(private_key, 2), elem(private_key, 3)}

    pem =
      :public_key.pem_encode([
        :public_key.pem_entry_encode(:RSAPublicKey, public_key)
      ])

    {pem, private_key}
  end

  defp decrypt(envelope, private_key) when is_map(envelope) do
    with "rsa-oaep-sha256-aes-256-gcm-v1" <- field(envelope, "version"),
         {:ok, encrypted_key} <- decode64_up_to(field(envelope, "encrypted_key"), 512),
         {:ok, iv} <- decode64_exact(field(envelope, "iv"), 12),
         {:ok, ciphertext} <-
           decode64_up_to(field(envelope, "ciphertext"), @maximum_output_bytes),
         {:ok, tag} <- decode64_exact(field(envelope, "tag"), 16),
         key when byte_size(key) == 32 <-
           :public_key.decrypt_private(encrypted_key, private_key,
             rsa_pad: :rsa_pkcs1_oaep_padding,
             rsa_oaep_md: :sha256
           ),
         output when is_binary(output) <-
           :crypto.crypto_one_time_aead(:aes_256_gcm, key, iv, ciphertext, "", tag, false),
         true <- String.valid?(output),
         true <- byte_size(output) <= @maximum_output_bytes do
      {:ok, output}
    else
      _ -> :error
    end
  rescue
    _error -> :error
  end

  defp decrypt(_envelope, _private_key), do: :error

  defp decode64_exact(value, exact_bytes) when is_binary(value) do
    case Base.decode64(value) do
      {:ok, decoded} when byte_size(decoded) == exact_bytes -> {:ok, decoded}
      _ -> :error
    end
  end

  defp decode64_up_to(value, maximum_bytes) when is_binary(value) do
    case Base.decode64(value) do
      {:ok, decoded} when byte_size(decoded) > 0 and byte_size(decoded) <= maximum_bytes ->
        {:ok, decoded}

      _ ->
        :error
    end
  end

  defp field(map, key), do: Map.get(map, key)

  defp bounded_output(output),
    do: String.slice(output, -@maximum_output_bytes, @maximum_output_bytes)

  defp refresh(entry), do: %{entry | expires_at: expires_at()}
  defp expires_at, do: DateTime.add(DateTime.utc_now(), @ttl_seconds, :second)
  defp schedule_prune, do: Process.send_after(self(), :prune, @prune_interval_ms)

  defp prune_inputs do
    now = System.monotonic_time(:millisecond)

    @input_table
    |> :ets.tab2list()
    |> Enum.each(fn
      {reference, _value, expires_at} when expires_at <= now ->
        :ets.delete(@input_table, reference)

      _entry ->
        :ok
    end)
  end

  defp prune(state) do
    now = DateTime.utc_now()
    Map.reject(state, fn {_key, entry} -> DateTime.compare(entry.expires_at, now) != :gt end)
  end
end
