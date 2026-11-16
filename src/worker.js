export default {
  async fetch() {
    return new Response("Maintenance", { status: 503 });
  },
};
