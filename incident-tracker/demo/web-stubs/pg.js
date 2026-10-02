export class Pool { constructor() { throw new Error('pg is not available in the browser demo; PGlite is used instead'); } }
export class Client extends Pool {}
export default { Pool, Client };
