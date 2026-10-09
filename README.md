# 听听学堂

手机、平板和电脑自适应的英语听读站，配合《每天五个词》纸质手册。21 周、147 天、525 词、1050 句例句，3150 个英美 MP3 已保存，播放不依赖在线语音生成服务。

## 登录与记录

使用家长指定的固定账号，输入姓名拼音和六位验证码。服务端校验，HTTPS 下以 HttpOnly、Secure、SameSite Cookie 保持登录 30 天；浏览器不保存验证码。设置中可以退出登录。

生产密码校验由同项目 Node.js 云函数使用原生 PBKDF2 完成；Edge 函数通过服务令牌调用它，并处理会话和 KV。继续使用当前四个账号环境变量。

学习标记和上次位置保存在腾讯云 **EdgeOne Pages KV**，另一台设备登录同一账号即可恢复。KV 最终一致，跨节点更新可能需要约 60 秒；页面提供同步状态和“立即同步”。断网时记录先进入本机持久队列，联网、切回页面或下次登录时重试。原浏览器学习标记首次登录后自动迁入账号；换域名需先导出旧站记录，再在新站恢复。

英美口音、速度和跟读停顿仍是各设备自己的偏好。没有注册功能或额外数据库服务器。

## 部署与开发

完整步骤见 [部署指南.md](部署指南.md)。先绑定变量 **LEARNING_KV** 的 KV 命名空间，导入本机 `.private/edgeone.env` 的四个环境变量，再重新部署。私有文件不提交 Git，不上传网页目录。

Git 部署：根目录为本仓库，构建 `npm run build`，输出 `dist`，Node 22+。无 npm 第三方依赖。

直接上传：`python scripts/package_static.py` 生成 `learning-station-edgeone.zip`，包含前端、全部音频、`edge-functions`、`cloud-functions` 与缓存配置。旧版纯静态包不能提供登录与同步。

`npm run dev` 启动 `http://127.0.0.1:8767/`，通过真实 HTTP 调用本地 Node 校验端点，用本机文件模拟 KV，不连接生产数据。真实 EdgeOne 调试：`edgeone login` 选择 China，`edgeone pages link` 关联项目，`edgeone pages dev` 调试。

`npm test` 覆盖错误登录、会话过期/篡改、CSRF、缓存禁用、跨设备合并、取消标记、KV 分页/延迟、存储失败、限流和离线补传。测试使用虚构账号。

修改账号可运行 `npm run setup-account`，经隐藏标准输入提供账号 JSON，再把新配置导入 EdgeOne。不要将账号 JSON 放在 shell 参数或 Git 中。设置脚本只保存加盐校验值和随机会话密钥，不保存明文验证码。

## 文件与维护

- `dist/app.js`、`styles.css`、`progress-sync.js`：前端源码。
- `server/learning-api.js`：认证、会话与 KV API，使用 Web Crypto 等边缘运行时 API。
- `edge-functions/`：EdgeOne 文件路由入口。
- `server/node-password-verifier.js`、`cloud-functions/`：原生 Node 密码校验及平台云函数入口。
- `.private/`：本机账户配置与开发 KV，Git 忽略。
- `scripts/build.mjs`：准备部署产物，不读取或嵌入私有配置。
- `scripts/parse_source.py`、`generate_audio.py`、`finish_audio.py`：更新资料和音频，不是运行网站的依赖。
- `source/`：内容和音频检查报告；原资料快照被 Git 忽略。
- `.openai/hosting.json`：历史 Sites 项目身份，当前 EdgeOne 不使用。

每个浏览器页面写入独立的不可变检查点，按词条逻辑版本合并；取消标记保留显式空值，避免旧记录复活。同词同时编辑时较高逻辑版本生效，同版本以写入端标识确定顺序。读取只取每个写入端的最新记录；历史检查点暂不自动删除，长期使用需关注 KV 用量。

接口验证会话、来源和格式，并禁用缓存。KV 最终一致使应用限流属于辅助保护，生产还应配置平台登录接口速率限制。学习记录 API 需要登录，普通资料和音频仍是公开静态资源。
