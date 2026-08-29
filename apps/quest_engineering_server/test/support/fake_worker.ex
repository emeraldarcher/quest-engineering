defmodule QuestEngineering.Server.FakeWorker.Connection do
  @moduledoc false
  use GenServer

  import Bitwise

  def start_link(options), do: GenServer.start_link(__MODULE__, options)
  def send_frame(connection, frame), do: GenServer.cast(connection, {:send_frame, frame})

  @impl true
  def init(options) do
    uri = URI.parse(Keyword.fetch!(options, :url))

    {:ok, socket} =
      :gen_tcp.connect(String.to_charlist(uri.host), uri.port, [:binary, active: false])

    key = Base.encode64(:crypto.strong_rand_bytes(16))
    path = uri.path <> if(uri.query, do: "?" <> uri.query, else: "")

    request = [
      "GET ",
      path,
      " HTTP/1.1\r\n",
      "Host: ",
      uri.host,
      ":",
      Integer.to_string(uri.port),
      "\r\n",
      "Upgrade: websocket\r\n",
      "Connection: Upgrade\r\n",
      "Sec-WebSocket-Key: ",
      key,
      "\r\n",
      "Sec-WebSocket-Version: 13\r\n\r\n"
    ]

    :ok = :gen_tcp.send(socket, request)
    {:ok, response} = receive_headers(socket, "")

    if String.starts_with?(response, "HTTP/1.1 101") do
      :ok = :inet.setopts(socket, active: :once)
      owner = Keyword.fetch!(options, :owner)
      send(owner, {:fake_worker_connected, self()})

      :ok =
        :gen_tcp.send(
          socket,
          encode_frame(1, Jason.encode!(Keyword.fetch!(options, :join_frame)))
        )

      {:ok, %{owner: owner, socket: socket, buffer: <<>>}}
    else
      {:stop, {:websocket_upgrade_failed, response}}
    end
  end

  @impl true
  def handle_info({:tcp, socket, bytes}, %{socket: socket} = state) do
    {frames, buffer} = decode_frames(state.buffer <> bytes, [])

    Enum.each(frames, fn
      {1, encoded} -> send(state.owner, {:fake_worker_frame, self(), Jason.decode!(encoded)})
      {9, payload} -> :gen_tcp.send(socket, encode_frame(10, payload))
      _frame -> :ok
    end)

    :ok = :inet.setopts(socket, active: :once)
    {:noreply, %{state | buffer: buffer}}
  end

  def handle_info({:tcp_closed, socket}, %{socket: socket} = state) do
    send(state.owner, {:fake_worker_disconnected, self(), :closed})
    {:stop, :normal, state}
  end

  def handle_info({:tcp_error, socket, reason}, %{socket: socket} = state) do
    send(state.owner, {:fake_worker_disconnected, self(), reason})
    {:stop, :normal, state}
  end

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def handle_cast({:send_frame, frame}, state) do
    :ok = :gen_tcp.send(state.socket, encode_frame(1, Jason.encode!(frame)))
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state) do
    :gen_tcp.close(state.socket)
    :ok
  end

  defp receive_headers(socket, received) do
    if String.contains?(received, "\r\n\r\n") do
      {:ok, received}
    else
      case :gen_tcp.recv(socket, 0, 5_000) do
        {:ok, bytes} -> receive_headers(socket, received <> bytes)
        error -> error
      end
    end
  end

  defp encode_frame(opcode, payload) do
    mask = :crypto.strong_rand_bytes(4)
    masked = mask(payload, mask)
    length = byte_size(payload)

    header =
      cond do
        length < 126 -> <<1::1, 0::3, opcode::4, 1::1, length::7>>
        length < 65_536 -> <<1::1, 0::3, opcode::4, 1::1, 126::7, length::16>>
        true -> <<1::1, 0::3, opcode::4, 1::1, 127::7, length::64>>
      end

    header <> mask <> masked
  end

  defp mask(payload, mask) do
    payload
    |> :binary.bin_to_list()
    |> Enum.with_index()
    |> Enum.map(fn {byte, index} -> bxor(byte, :binary.at(mask, rem(index, 4))) end)
    |> :binary.list_to_bin()
  end

  defp decode_frames(
         <<_fin::1, _rsv::3, opcode::4, masked::1, short_length::7, rest::binary>> = all,
         frames
       ) do
    with {:ok, length, rest} <- extended_length(short_length, rest),
         {:ok, mask, rest} <- frame_mask(masked, rest),
         true <- byte_size(rest) >= length do
      <<payload::binary-size(^length), remaining::binary>> = rest
      payload = if mask, do: mask(payload, mask), else: payload
      decode_frames(remaining, [{opcode, payload} | frames])
    else
      _incomplete -> {Enum.reverse(frames), all}
    end
  end

  defp decode_frames(buffer, frames), do: {Enum.reverse(frames), buffer}

  defp extended_length(length, rest) when length < 126, do: {:ok, length, rest}
  defp extended_length(126, <<length::16, rest::binary>>), do: {:ok, length, rest}
  defp extended_length(127, <<length::64, rest::binary>>), do: {:ok, length, rest}
  defp extended_length(_length, _rest), do: :incomplete

  defp frame_mask(0, rest), do: {:ok, nil, rest}
  defp frame_mask(1, <<mask::binary-size(4), rest::binary>>), do: {:ok, mask, rest}
  defp frame_mask(_masked, _rest), do: :incomplete
end

defmodule QuestEngineering.Server.FakeWorker do
  @moduledoc "A controllable, deduplicating Worker that uses the real WebSocket protocol."

  use GenServer

  alias QuestEngineering.Server.FakeWorker.Connection

  @topic "worker:control"

  def start_link(options), do: GenServer.start_link(__MODULE__, options)
  def connect(worker), do: GenServer.call(worker, :connect, 5_000)
  def disconnect(worker), do: GenServer.call(worker, :disconnect)
  def connected?(worker), do: GenServer.call(worker, :connected?)
  def registration_error(worker), do: GenServer.call(worker, :registration_error)
  def known_dispatches(worker), do: GenServer.call(worker, :known_dispatches)
  def send_message(worker, message), do: GenServer.call(worker, {:send_message, message})

  def execution_count(worker, action_id),
    do: GenServer.call(worker, {:execution_count, action_id})

  def drop_ack(worker, value), do: GenServer.call(worker, {:drop_ack, value})
  def drop_completion(worker, value), do: GenServer.call(worker, {:drop_completion, value})
  def mark_running(worker, action_id), do: GenServer.call(worker, {:mark_running, action_id})

  def complete(worker, action_id, outputs),
    do: GenServer.call(worker, {:complete, action_id, outputs})

  def fail(worker, action_id, failure), do: GenServer.call(worker, {:fail, action_id, failure})
  def forget(worker, action_id), do: GenServer.call(worker, {:forget, action_id})

  @impl true
  def init(options) do
    state = %{
      worker_id: Keyword.fetch!(options, :worker_id),
      capabilities:
        options
        |> Keyword.get(:capabilities, default_capabilities())
        |> Map.put_new("workspace_bindings", []),
      protocol_version: Keyword.get(options, :protocol_version, 4),
      hello_payload: Keyword.get(options, :hello_payload),
      url: Keyword.get(options, :url, "ws://127.0.0.1:4002/worker/websocket"),
      token: Keyword.get(options, :token, "development-worker-token"),
      connection: nil,
      monitor: nil,
      connected?: false,
      registered?: false,
      known: %{},
      worktrees: %{},
      execution_counts: %{},
      drop_ack?: false,
      drop_completion?: false,
      last_error: nil,
      ref: 1
    }

    if Keyword.get(options, :connect, true) do
      send(self(), :connect)
    end

    {:ok, state}
  end

  @impl true
  def handle_call(:connect, _from, %{connection: nil} = state) do
    case start_connection(state) do
      {:ok, next} -> {:reply, :ok, next}
      {:error, error} -> {:reply, {:error, error}, state}
    end
  end

  def handle_call(:connect, _from, state), do: {:reply, :ok, state}

  def handle_call(:disconnect, _from, %{connection: nil} = state),
    do: {:reply, :ok, %{state | connected?: false, registered?: false}}

  def handle_call(:disconnect, _from, state) do
    GenServer.stop(state.connection, :normal)
    {:reply, :ok, %{state | connection: nil, monitor: nil, connected?: false, registered?: false}}
  end

  def handle_call(:connected?, _from, state), do: {:reply, state.registered?, state}
  def handle_call(:registration_error, _from, state), do: {:reply, state.last_error, state}
  def handle_call(:known_dispatches, _from, state), do: {:reply, state.known, state}

  def handle_call({:send_message, message}, _from, state),
    do: {:reply, :ok, send_protocol(state, message)}

  def handle_call({:execution_count, action_id}, _from, state),
    do: {:reply, Map.get(state.execution_counts, action_id, 0), state}

  def handle_call({:drop_ack, value}, _from, state),
    do: {:reply, :ok, %{state | drop_ack?: value}}

  def handle_call({:drop_completion, value}, _from, state),
    do: {:reply, :ok, %{state | drop_completion?: value}}

  def handle_call({:mark_running, action_id}, _from, state) do
    case fetch_known(state, action_id) do
      {:ok, dispatch} ->
        dispatch = %{dispatch | state: :running}
        next = put_in(state.known[action_id], dispatch)
        {:reply, :ok, maybe_send_state(next, dispatch)}

      error ->
        {:reply, error, state}
    end
  end

  def handle_call({:complete, action_id, outputs}, _from, state) do
    case fetch_known(state, action_id) do
      {:ok, dispatch} ->
        dispatch = %{dispatch | state: :completed, outputs: outputs}
        next = put_in(state.known[action_id], dispatch)

        next =
          if next.registered? and not next.drop_completion? do
            send_protocol(next, completion_message(next, dispatch))
          else
            next
          end

        {:reply, :ok, next}

      error ->
        {:reply, error, state}
    end
  end

  def handle_call({:fail, action_id, failure}, _from, state) do
    case fetch_known(state, action_id) do
      {:ok, dispatch} ->
        dispatch = %{dispatch | state: :failed, failure: failure}
        next = put_in(state.known[action_id], dispatch)
        message = state_message(next, dispatch)
        {:reply, :ok, if(next.registered?, do: send_protocol(next, message), else: next)}

      error ->
        {:reply, error, state}
    end
  end

  def handle_call({:forget, action_id}, _from, state),
    do: {:reply, :ok, %{state | known: Map.delete(state.known, action_id)}}

  @impl true
  def handle_info(:connect, state) do
    case start_connection(state) do
      {:ok, next} -> {:noreply, next}
      {:error, _error} -> {:noreply, state}
    end
  end

  def handle_info({:fake_worker_connected, pid}, %{connection: pid} = state),
    do: {:noreply, %{state | connected?: true}}

  def handle_info({:fake_worker_frame, pid, frame}, %{connection: pid} = state),
    do: {:noreply, handle_frame(frame, state)}

  def handle_info({:fake_worker_disconnected, pid, _reason}, %{connection: pid} = state),
    do: {:noreply, %{state | connected?: false, registered?: false}}

  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{monitor: ref} = state),
    do:
      {:noreply, %{state | connection: nil, monitor: nil, connected?: false, registered?: false}}

  def handle_info(_message, state), do: {:noreply, state}

  defp start_connection(state) do
    query = URI.encode_query(%{"vsn" => "2.0.0", "worker_token" => state.token})
    url = state.url <> "?" <> query

    hello =
      state.hello_payload ||
        %{
          "type" => "worker_hello",
          "protocol_version" => state.protocol_version,
          "worker_id" => state.worker_id,
          "capabilities" => state.capabilities
        }

    join_frame = ["1", "1", @topic, "phx_join", hello]

    case Connection.start_link(owner: self(), url: url, join_frame: join_frame) do
      {:ok, pid} -> {:ok, %{state | connection: pid, monitor: Process.monitor(pid)}}
      error -> error
    end
  end

  defp handle_frame([_join_ref, "1", @topic, "phx_reply", %{"status" => "ok"}], state),
    do: %{state | registered?: true}

  defp handle_frame([_join_ref, "1", @topic, "phx_reply", %{"status" => "error"} = reply], state),
    do: %{state | registered?: false, last_error: reply}

  defp handle_frame([_join_ref, _ref, @topic, "protocol", message], state),
    do: handle_protocol(message, state)

  defp handle_frame(_frame, state), do: state

  defp handle_protocol(%{"type" => "provision_run_worktree", "worktree" => worktree}, state) do
    ready = %{
      "type" => "run_worktree_ready",
      "protocol_version" => state.protocol_version,
      "worker_id" => state.worker_id,
      "worktree" => %{
        "worktree_id" => worktree["worktree_id"],
        "run_id" => worktree["run_id"],
        "workspace_binding_id" => worktree["workspace_binding_id"],
        "base_revision" => String.duplicate("a", 40),
        "branch_name" => worktree["branch_name"],
        "canonical_root" => "/managed/worktrees/" <> worktree["worktree_id"],
        "source_dirty_excluded" => false,
        "identity_hash" => worktree["identity_hash"]
      }
    }

    state
    |> Map.update!(:worktrees, &Map.put(&1, worktree["worktree_id"], ready))
    |> send_protocol(ready)
  end

  defp handle_protocol(%{"type" => "reconcile_run_worktrees", "worktrees" => worktrees}, state) do
    Enum.reduce(worktrees, state, fn request, current ->
      case current.worktrees[request["worktree_id"]] do
        nil -> current
        ready -> send_protocol(current, ready)
      end
    end)
  end

  defp handle_protocol(%{"type" => "execute_action", "execution" => execution} = action, state) do
    identity = execution["identity"]

    case Map.fetch(state.known, identity["action_id"]) do
      :error ->
        dispatch = %{
          action_id: identity["action_id"],
          occurrence_id: identity["occurrence_id"],
          attempt_id: identity["attempt_id"],
          state: :accepted,
          outputs: nil,
          failure: nil,
          wire_action: action
        }

        next = %{
          state
          | known: Map.put(state.known, dispatch.action_id, dispatch),
            execution_counts: Map.update(state.execution_counts, dispatch.action_id, 1, &(&1 + 1))
        }

        maybe_ack(next, dispatch)

      {:ok, dispatch} ->
        # The stable Action ID is the local idempotency key. Duplicate delivery
        # reports existing state and never increments execution_counts.
        report_existing(state, dispatch)
    end
  end

  defp handle_protocol(%{"type" => "reconcile_request"}, state) do
    dispatches = state.known |> Map.values() |> Enum.map(&state_payload/1)

    send_protocol(state, %{
      "type" => "reconcile_state",
      "protocol_version" => state.protocol_version,
      "worker_id" => state.worker_id,
      "dispatches" => dispatches
    })
  end

  defp handle_protocol(%{"type" => "connection_superseded"}, state) do
    if state.connection, do: GenServer.stop(state.connection, :normal)
    %{state | connection: nil, monitor: nil, connected?: false, registered?: false}
  end

  defp handle_protocol(_message, state), do: state

  defp maybe_ack(%{drop_ack?: true} = state, _dispatch), do: state

  defp maybe_ack(state, dispatch),
    do: send_protocol(state, accepted_message(state, dispatch))

  defp report_existing(state, %{state: :accepted} = dispatch), do: maybe_ack(state, dispatch)

  defp report_existing(state, dispatch),
    do: send_protocol(state, state_message(state, dispatch))

  defp maybe_send_state(%{registered?: true} = state, dispatch),
    do: send_protocol(state, state_message(state, dispatch))

  defp maybe_send_state(state, _dispatch), do: state

  defp accepted_message(state, dispatch) do
    identity_message(state, dispatch, "dispatch_accepted")
  end

  defp completion_message(state, dispatch) do
    state
    |> identity_message(dispatch, "step_completed")
    |> Map.put("outputs", dispatch.outputs)
  end

  defp state_message(state, dispatch) do
    payload =
      state
      |> identity_message(dispatch, "dispatch_state")
      |> Map.put("state", Atom.to_string(dispatch.state))

    payload
    |> maybe_put("outputs", dispatch.outputs)
    |> maybe_put("failure", dispatch.failure)
  end

  defp state_payload(dispatch) do
    %{
      "action_id" => dispatch.action_id,
      "occurrence_id" => dispatch.occurrence_id,
      "attempt_id" => dispatch.attempt_id,
      "state" => Atom.to_string(dispatch.state)
    }
    |> maybe_put("outputs", dispatch.outputs)
    |> maybe_put("failure", dispatch.failure)
  end

  defp identity_message(state, dispatch, type) do
    %{
      "type" => type,
      "protocol_version" => state.protocol_version,
      "worker_id" => state.worker_id,
      "action_id" => dispatch.action_id,
      "occurrence_id" => dispatch.occurrence_id,
      "attempt_id" => dispatch.attempt_id
    }
  end

  defp send_protocol(%{connection: connection} = state, message) when is_pid(connection) do
    ref = Integer.to_string(state.ref + 1)
    frame = ["1", ref, @topic, "protocol", message]
    Connection.send_frame(connection, frame)
    %{state | ref: state.ref + 1}
  end

  defp send_protocol(state, _message), do: state
  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp fetch_known(state, action_id) do
    case Map.fetch(state.known, action_id) do
      {:ok, dispatch} -> {:ok, dispatch}
      :error -> {:error, :unknown_dispatch}
    end
  end

  defp default_capabilities do
    %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => ["fake"],
      "workspace_bindings" => [],
      "executors" => [
        %{
          "adapter" => "fake",
          "models" => [%{"provider" => "fake", "model" => "test"}],
          "reasoning" => ["low", "medium", "high"],
          "tools" => ["workspace.filesystem", "workspace.search", "terminal.shell"],
          "workspaces" => [
            %{
              "ref" => "workspace:test",
              "root" => "/workspace",
              "max_access" => "read_write"
            }
          ]
        }
      ]
    }
  end
end
