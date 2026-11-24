class GatewayModelsError extends Error {
  status = 502;
}

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

    if (!res.ok) throw new GatewayModelsError(`Magpie 网关返回 HTTP ${res.status}`);

    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.data;
    if (!Array.isArray(list)) throw new GatewayModelsError('Magpie 网关返回的模型列表格式不正确');

    return list.map((item) => {
      const id = typeof item === 'string' ? item : (item.id || '');
      const name = (typeof item === 'object' && item.name) ? item.name : id;
      const provider = (typeof item === 'object' && item.owned_by) ? item.owned_by : (id.includes('/') ? id.split('/')[0] : '');
      return { id: id && !id.startsWith('magpie/') ? `magpie/${id}` : id, name, provider };
    }).filter((m) => !!m.id);
  } catch (err) {
    if (err instanceof GatewayModelsError) throw err;
    throw new GatewayModelsError('无法读取 Magpie 网关的模型列表', { cause: err });
  }
}
