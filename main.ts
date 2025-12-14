import { Plugin, TFile, ItemView, WorkspaceLeaf, PluginSettingTab, Setting, App } from 'obsidian';
import { parseNoteFile } from './parser';
import { renderNotabilityFile } from './rendering';
import { NotabilityPluginSettings, NotabilityData } from './types';

const VIEW_TYPE_NOTABILITY = 'notability-view';

class NotabilityView extends ItemView {
    file: TFile | null;
    settings: NotabilityPluginSettings;
    
    constructor(leaf: WorkspaceLeaf, settings: NotabilityPluginSettings) {
        super(leaf);
        this.file = null;
        this.settings = settings;
    }
    
    getViewType(): string {
        return VIEW_TYPE_NOTABILITY;
    }
    
    getDisplayText(): string {
        return this.file ? this.file.basename : 'Notability';
    }
    
    getIcon(): string {
        return 'pencil';
    }
    
    async onOpen() {
    }
    
    async render() {
        if (!this.file) {
            return;
        }
        
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('notability-view');
        
        const canvasContainer = container.createEl('div', {
            cls: 'notability-canvas-container'
        });
        
        const canvas = canvasContainer.createEl('canvas', {
            cls: 'notability-canvas'
        });
        
        const loading = container.createEl('div', {
            cls: 'notability-loading'
        });
        
        try {
            await this.renderNotabilityFile(canvas);
            loading.remove();
        } catch (error) {
            console.error('ERROR rendering:', error);
            loading.remove();
            container.createEl('div', {
                cls: 'notability-error',
                text: `Error: ${error.message}`
            });
        }
    }
    
    async renderNotabilityFile(canvas: HTMLCanvasElement) {
        if (!this.file) {
            throw new Error('No file available to render');
        }
        
        const arrayBuffer = await this.app.vault.readBinary(this.file);
        const noteData = await parseNoteFile(arrayBuffer);
        
        await renderNotabilityFile(canvas, noteData, this.settings);
    }
    
    getState(): any {
        return {
            file: this.file?.path || null
        };
    }
    
    async setState(state: any, result: { history: boolean }): Promise<void> {
        if (state && state.file && typeof state.file === 'string') {
            const file = this.app.vault.getAbstractFileByPath(state.file);
            if (file instanceof TFile) {
                this.file = file;
                if (this.containerEl && this.containerEl.children[1]) {
                    await this.render();
                }
            }
        }
    }
    
    updateSettings(settings: NotabilityPluginSettings) {
        this.settings = settings;
        if (this.file) {
            this.render();
        }
    }
    
    async onClose() {
    }
}

class NotabilitySettingTab extends PluginSettingTab {
    plugin: NotabilityPlugin;

    constructor(app: App, plugin: NotabilityPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl('h2', { text: 'Notability Renderer Settings' });

        new Setting(containerEl)
            .setName('Crop to Content')
            .setDesc('Automatically crop edges to fit the drawing content')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.cropToContent)
                .onChange(async (value) => {
                    this.plugin.settings.cropToContent = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateAllViews();
                }));
    }
}

export default class NotabilityPlugin extends Plugin {
    settings: NotabilityPluginSettings;

    async onload() {
        await this.loadSettings();

        this.registerView(
            VIEW_TYPE_NOTABILITY,
            (leaf) => new NotabilityView(leaf, this.settings)
        );
        
        this.registerExtensions(['note'], VIEW_TYPE_NOTABILITY);

        this.addSettingTab(new NotabilitySettingTab(this.app, this));
    }
    
    onunload() {
    }

    async loadSettings() {
        this.settings = Object.assign({
            cropToContent: true
        }, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    updateAllViews() {
        this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTABILITY).forEach(leaf => {
            const view = leaf.view as NotabilityView;
            if (view) {
                view.updateSettings(this.settings);
            }
        });
    }
}
