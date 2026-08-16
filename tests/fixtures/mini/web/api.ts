import { UserName } from "./types";

export interface User {
	id: string;
	name: UserName;
}

export async function loadUser(id: string): Promise<User> {
	const res = await fetch(`/api/users/${id}`);
	return res.json();
}

export async function createUser(name: string): Promise<User> {
	const res = await fetch("/api/users", { method: "POST" });
	return res.json();
}
declare const axios: { get: (url: string) => Promise<unknown> };
export const fetchOrder = (id: string) => axios.get(`/api/orders/${id}`);

