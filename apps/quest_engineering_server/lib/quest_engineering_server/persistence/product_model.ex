defmodule QuestEngineering.Server.Persistence.ProductClass do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  schema "product_classes" do
    field :key, :string
    field :name, :string
    field :description, :string, default: ""
    field :instructions, :string
    field :archived_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  def create_changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [:id, :key, :name, :description, :instructions], empty_values: [])
    |> validate_required([:id, :key, :name, :instructions])
    |> unique_constraint(:key)
  end

  def update_changeset(row, attributes) do
    row
    |> cast(attributes, [:name, :description, :instructions], empty_values: [])
    |> validate_required([:name, :instructions])
  end
end

defmodule QuestEngineering.Server.Persistence.ProductLoadout do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  schema "product_loadouts" do
    field :key, :string
    field :name, :string
    field :description, :string, default: ""
    field :model_provider, :string
    field :model_name, :string
    field :reasoning, :string
    field :tools, {:array, :string}, default: []
    field :workspace_access, :string
    field :archived_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  def create_changeset(attributes) do
    %__MODULE__{}
    |> cast(
      attributes,
      [
        :id,
        :key,
        :name,
        :description,
        :model_provider,
        :model_name,
        :reasoning,
        :tools,
        :workspace_access
      ],
      empty_values: []
    )
    |> common_changeset()
    |> unique_constraint(:key)
  end

  def update_changeset(row, attributes) do
    row
    |> cast(
      attributes,
      [
        :name,
        :description,
        :model_provider,
        :model_name,
        :reasoning,
        :tools,
        :workspace_access
      ],
      empty_values: []
    )
    |> common_changeset()
  end

  defp common_changeset(changeset) do
    changeset
    |> validate_required([
      :key,
      :name,
      :model_provider,
      :model_name,
      :reasoning,
      :tools,
      :workspace_access
    ])
    |> validate_inclusion(:reasoning, ["low", "medium", "high"])
    |> validate_inclusion(:workspace_access, ["none", "read_only", "read_write"])
    |> check_constraint(:reasoning, name: :product_loadouts_reasoning_valid)
    |> check_constraint(:workspace_access, name: :product_loadouts_workspace_access_valid)
  end
end

defmodule QuestEngineering.Server.Persistence.ProductSquad do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  schema "product_squads" do
    field :key, :string
    field :name, :string
    field :description, :string, default: ""
    field :archived_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  def create_changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [:id, :key, :name, :description], empty_values: [])
    |> validate_required([:id, :key, :name])
    |> unique_constraint(:key)
  end

  def update_changeset(row, attributes) do
    row
    |> cast(attributes, [:name, :description], empty_values: [])
    |> validate_required([:name])
  end
end

defmodule QuestEngineering.Server.Persistence.ProductSquadMember do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key false
  schema "product_squad_members" do
    field :squad_id, Ecto.UUID, primary_key: true
    field :member_key, :string, primary_key: true
    field :name, :string
    field :class_id, Ecto.UUID
    field :loadout_id, Ecto.UUID
    field :position, :integer
  end

  def changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [:squad_id, :member_key, :name, :class_id, :loadout_id, :position])
    |> validate_required([:squad_id, :member_key, :name, :class_id, :loadout_id, :position])
    |> validate_number(:position, greater_than_or_equal_to: 0)
    |> foreign_key_constraint(:squad_id)
    |> foreign_key_constraint(:class_id)
    |> foreign_key_constraint(:loadout_id)
    |> unique_constraint([:squad_id, :member_key],
      name: :product_squad_members_pkey
    )
    |> unique_constraint([:squad_id, :position])
    |> check_constraint(:position, name: :product_squad_members_position_non_negative)
  end
end

defmodule QuestEngineering.Server.Persistence.ProductTactic do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  schema "product_tactics" do
    field :key, :string
    field :name, :string
    field :description, :string, default: ""
    field :body, :map
    field :archived_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  def create_changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [:id, :key, :name, :description, :body], empty_values: [])
    |> validate_required([:id, :key, :name, :body])
    |> unique_constraint(:key)
  end

  def update_changeset(row, attributes) do
    row
    |> cast(attributes, [:name, :description, :body], empty_values: [])
    |> validate_required([:name, :body])
  end
end

defmodule QuestEngineering.Server.Persistence.ProductQuest do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  schema "product_quests" do
    field :title, :string
    field :objective, :string
    field :workspace_ref, :string
    field :squad_id, Ecto.UUID
    field :tactic_source_type, :string
    field :inline_tactic, :map
    field :tactic_definition_id, Ecto.UUID
    field :archived_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  def create_changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [
      :id,
      :title,
      :objective,
      :workspace_ref,
      :squad_id,
      :tactic_source_type,
      :inline_tactic,
      :tactic_definition_id
    ])
    |> common_changeset()
  end

  def update_changeset(row, attributes) do
    row
    |> cast(attributes, [
      :title,
      :objective,
      :workspace_ref,
      :squad_id,
      :tactic_source_type,
      :inline_tactic,
      :tactic_definition_id
    ])
    |> common_changeset()
  end

  defp common_changeset(changeset) do
    changeset
    |> validate_required([:title, :objective, :workspace_ref, :squad_id, :tactic_source_type])
    |> validate_inclusion(:tactic_source_type, ["inline", "definition"])
    |> foreign_key_constraint(:squad_id)
    |> foreign_key_constraint(:tactic_definition_id)
    |> check_constraint(:tactic_source_type, name: :product_quests_tactic_source_valid)
  end
end
