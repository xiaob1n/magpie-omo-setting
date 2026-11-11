# magpie-omo-setting

magpie 独立页面插件：OmO 任务类别与子代理配置管理，支持 WebDAV 云端同步与多端备份。

## 功能特性

- **独立页面界面**：集成在 magpie 侧边栏「插件」分组中，提供原生的页面布局与深色/浅色主题支持。
- **OmO 类别配置 (Categories)**：直观配置 `visual-engineering`, `ultrabrain`, `deep-low`, `deep-high`, `artistry`, `quick`, `writing` 等所有 OmO 任务类别的模型优先级列表（支持添加、上移、下移、删除）与推理档位（`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto` 及自定义）。
- **子代理配置 (Subagents)**：管理四大核心命名子代理（`explore`, `librarian`, `plan-consultant`, `plan-reviewer`）的主模型与推理档位。
- **无损 JSONC 读写**：采用原子写入与版本核对 (Revision CAS) 机制，安全修改 `~/.omo/omo.jsonc`，保留文件注释与原有其他配置项。
- **网关模型自动补全**：实时从 magpie 网关拉取已启用的模型列表，支持快速搜索选择，亦支持手动输入任意自定义模型。
- **WebDAV 云端同步**：
  - 支持一键复用 magpie 已有的坚果云 / WebDAV 凭据（自动读取 `~/.config/magpie/sync.json`）。
  - 支持配置独立的 WebDAV 服务器、用户名、应用密码与云端路径（默认 `magpie/omo/omo.jsonc`）。
  - 支持「备份到云端」与「从云端恢复」，云端拉取前自动保留本地带时间戳的历史备份。

## 安装与使用

使用 Bun 运行。源码安装前执行 `bun install --frozen-lockfile`，安装锁定的 `jsonc-parser` 依赖；配置编辑使用该库按路径修改 JSONC，保留未编辑字段和注释。

### 安装插件

在终端中执行：
```sh
magpie plugin add /Users/lubinze/Desktop/magpie-omo-setting
```
或在 magpie 的「插件 › 已安装」中选择添加本地文件夹。

### 打开设置页

安装完成后，侧边栏「插件」分组下将出现 **OmO 设置** 标签页，点击即可打开配置管理界面。

### 插件选项

若需要修改插件本地服务的回环监听端口（默认 3488）：
```sh
magpie plugin options magpie-omo-setting '{"port": 3489}'
```

## 常见问题

### 保存与云端恢复

四个命名子代理即使尚未出现在配置中也可编辑并保存。旧版类别的模型只读，推理档位可编辑；格式错误项只读。模型列表来自 Magpie 网关，选择时转换为 OmO 使用的 `magpie/` 前缀标识；手动输入保留原样。

WebDAV 每 3 分钟自动上传一次本机改动（服务端定时，页面关着也生效）：只有本机改过、且远端自上次同步后没被别处改过时才上传；两边都改了会跳过并提示，绝不覆盖任何一侧。「备份到云端」是同一动作的立即执行，不需要确认；「从云端恢复」会覆盖本地，仍然需要确认，且覆盖前自动备份本地文件、校验远端配置后原子替换。保存配置保存即生效，没有二次确认。独立凭据文件权限为 `0600`，API 不返回密码，密码框留空时保留已保存的密码。

插件只在 Magpie 调用服务生命周期时启动；独立调试可执行 `bun index.mjs`。API 使用本次进程的随机令牌，仅对 opaque iframe 的 `Origin: null` 设置 CORS 读取头。前端使用相对 API 路径以兼容 Magpie 服务代理前缀。

### 回归测试

执行 `bun test --timeout 10000`。测试使用临时 HOME、临时 OmO 文件、本地随机端口假 DAV 和插件 HTTP 服务，不需要真实账号或浏览器。界面测试是 DOM 行为测试；实际窗口验收由用户在 Magpie 中完成（页面加载、改档位保存后刷新），服务导航后的父窗口主题继承仍靠 bridge 令牌继承，未单独立项验证。

### 页面一直停在「正在连接 OmO 设置服务…」

页面插件本身不带后台，配置文件的读写由插件宿主（Bun）运行的本机服务完成。文件夹方式安装的插件不会触发 Bun 下载，所以首次使用时 magpie 可能还没有可用于插件的 Bun。

任选一种方式补齐：

```sh
# 1. 先添加任意一个 npm 插件，magpie 会顺带下载它自己的 Bun
magpie plugin add @magpie-community/middleware-model-map

# 2. 或者直接指定系统里已有的 Bun
launchctl setenv MAGPIE_BUN "$HOME/.bun/bin/bun"
```

第二种方式设置后需要重启 magpie 客户端。补齐后在客户端把本插件关掉再打开，让插件宿主重启，页面即可加载。

## 许可证

MIT
