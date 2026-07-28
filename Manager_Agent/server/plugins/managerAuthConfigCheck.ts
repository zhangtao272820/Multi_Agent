import { getManagerWsAuthConfigStatus } from '../graph/core/runtime/wsAuth'

/** S1：启动时检测 AUTH_MODE=token 却无 token 的配置脚枪 */
export default defineNitroPlugin(() => {
  const auth = getManagerWsAuthConfigStatus()
  if (!auth.ok) {
    console.error(
      `[manager boot] ${auth.detail}: MANAGER_AUTH_MODE=token（或 MANAGER_WS_AUTH=1）须配置 MANAGER_WS_TOKEN；` +
        '否则 /api/ready 为 not-ready，WS 鉴权会拒绝所有连接。裸机本地可设 MANAGER_AUTH_MODE=open。'
    )
  }
})
