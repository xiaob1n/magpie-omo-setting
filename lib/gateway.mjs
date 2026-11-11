// 获取 magpie 网关提供的可用模型列表
export async function fetchGatewayModels() {
  const addr = process.env.MAGPIE_ADDR || '127.0.0.1:3425';
  const url = `http://${addr}/v1/models`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      return [];
    }

    const data = await res.json().catch(() => ({}));
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);

    return list.map((item) => {
      const id = typeof item === 'string' ? item : (item.id || '');
      const name = (typeof item === 'object' && item.name) ? item.name : id;
      const provider = (typeof item === 'object' && item.owned_by) ? item.owned_by : (id.includes('/') ? id.split('/')[0] : '');
      return { id: id && !id.startsWith('magpie/') ? `magpie/${id}` : id, name, provider };
    }).filter((m) => !!m.id);
  } catch (err) {
    return [];
  }
}
