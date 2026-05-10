import re
import sys

def process_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Import AgentPanelV2.css
    content = content.replace("import './agent-panel.css';", "import './AgentPanelV2.css';")
    # if it was commented out:
    content = content.replace("// import './agent-panel.css';", "import './AgentPanelV2.css';")

    # Rename main component
    content = content.replace("export const AgUiPanel: React.FC", "export const AgentPanelV2: React.FC")

    # Rename ToolCallCard
    content = content.replace("agu-tool-card", "ap-tool-call")
    content = content.replace("agu-tool-card__header", "ap-tool-call-header")
    content = content.replace("agu-tool-card__icon", "ap-tool-icon")
    content = content.replace("agu-tool-card__name", "ap-tool-name")
    content = content.replace("agu-tool-card__status-dot", "ap-tool-status")
    content = content.replace("agu-tool-card__chevron", "ap-tool-chevron")
    content = content.replace("agu-tool-card__body", "ap-tool-body")
    content = content.replace("agu-tool-card__section", "ap-tool-section")
    content = content.replace("agu-tool-card__section-label", "ap-tool-section-label")
    content = content.replace("agu-tool-card__pre", "ap-tool-pre")

    # Rename rail (drawer)
    content = content.replace("agu-rail-overlay", "ap-drawer-overlay")
    content = content.replace("agu-rail", "ap-drawer")
    content = content.replace("agu-rail__header", "ap-drawer-header")
    content = content.replace("agu-rail__title", "ap-drawer-title")
    content = content.replace("agu-rail__new-btn", "ap-icon-btn")
    content = content.replace("agu-rail__list", "ap-drawer-list")
    content = content.replace("agu-rail__empty", "ap-drawer-empty")
    content = content.replace("agu-rail__item", "ap-session-item")
    content = content.replace("agu-rail__item-btn", "ap-session-btn")
    content = content.replace("agu-rail__item-dot", "ap-session-dot")
    content = content.replace("agu-rail__item-info", "ap-session-info")
    content = content.replace("agu-rail__item-time", "ap-session-date")
    content = content.replace("agu-rail__item-model", "ap-session-title")
    content = content.replace("agu-rail__item-delete", "ap-icon-btn")

    # Rename Panel
    content = content.replace("agu-panel ag-ui-panel--pro", "ap-container")
    content = content.replace("agu-panel__empty", "ap-thread-empty")
    content = content.replace("agu-panel__empty--error", "ap-thread-error")
    content = content.replace("agu-btn agu-btn--sm", "ap-pill")
    content = content.replace("agu-panel__header", "ap-header")
    content = content.replace("agu-panel__header-left", "ap-header-title")
    content = content.replace("agu-panel__history-btn", "ap-icon-btn")
    content = content.replace("agu-panel__title", "")
    content = content.replace("agu-panel__status-pill", "ap-header-status")
    content = content.replace("agu-panel__header-right", "ap-header-actions")
    content = content.replace("agu-panel__new-btn", "ap-pill")
    content = content.replace("agu-panel__chat-wrap", "ap-chat-wrap")
    content = content.replace("agu-panel__footer", "ap-composer-container")

    # Manual history chat wrapper
    content = content.replace("agu-chat-with-history-manual", "ap-chat-wrap")
    content = content.replace("agu-history-messages", "copilotKitMessages")
    content = content.replace("agu-chat", "")

    # Overwrite the file
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

process_file(r"e:\Main EL Sem 4\IntelliBoard\frontend\src\components\agent\AgentPanelV2.tsx")
