# Git 操作规则

## 红线规则（必须严格遵守）

- **向远端推送（push）必须人工确认**：未经主人明确允许，禁止执行 git push
- **从远端拉取（pull/fetch）可以自动放行**：允许自动执行 git pull / git fetch

## 仓库信息

- **仓库地址**：https://github.com/WarriorMFY/GoalDrivenAigc.git
- **镜像地址**：https://ghfast.top/https://github.com/WarriorMFY/GoalDrivenAigc.git（仅用于拉取，不支持推送）
- **认证方式**：Personal Access Token（已配置）

## 常用操作

### 拉取最新（自动放行）
```bash
git pull origin main
```

### 推送到远端（需人工确认）
```bash
# 必须先征得主人同意
git push origin main
```

## 注意事项

1. 推送前必须向主人说明：将要推送的 commit 内容、影响范围
2. 等待主人明确回复"可以"、"确认"等才能执行
3. 拉取操作无需确认，可直接执行
