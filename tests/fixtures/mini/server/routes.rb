Rails.application.routes.draw do
  get "/up", to: "health#show"
  get "/mystatus", to: "health#status"
  match "/webhook", to: "hooks#receive", via: [:post, :put]
end
