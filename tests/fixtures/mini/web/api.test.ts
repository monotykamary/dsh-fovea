import { loadUser, createUser } from "./api";

export async function testLoadUser() {
	const u = await loadUser("1");
	if (!u.name) throw new Error("no name");
	await createUser("x");
}
