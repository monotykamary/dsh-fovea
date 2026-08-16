defmodule Demo.Router do
  use Phoenix.Router

  scope "/api" do
    get "/elixir-health", HealthController, :show
    post "/elixir-events", EventsController, :create
  end

  forward "/ops", OpsRouter
end
