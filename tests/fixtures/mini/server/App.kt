package demo

fun Application.configureRouting() {
  routing {
    get("/ktor-ping") { call.respond("pong") }
    post("/ktor-hook") { call.respond(HttpStatusCode.OK) }
  }
}
