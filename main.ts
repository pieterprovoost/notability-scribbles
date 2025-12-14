import { Plugin, TFile, ItemView, WorkspaceLeaf, PluginSettingTab, Setting, App } from 'obsidian';
import JSZip from 'jszip';
import { decode, PLDictionary, PLArray, PLString, PLData } from '@hqtsm/plist';

const VIEW_TYPE_NOTABILITY = 'notability-view';

// Note: @hqtsm/plist is a zero-dependency browser-compatible parser that works with ArrayBuffer

interface CurveData {
    points: Array<{ x: number; y: number }>;
    width: number;
    color: string;
}

interface NotabilityData {
    curves: CurveData[];
    width: number;
    height: number;
}

interface NotabilityPluginSettings {
    cropToContent: boolean;
}

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
        // const state = this.leaf.getViewState();
        // if (state.state && typeof state.state === 'object' && 'file' in state.state) {
        //     const filePath = (state.state as any).file;
        //     if (typeof filePath === 'string') {
        //         const file = this.app.vault.getAbstractFileByPath(filePath);
        //         if (file instanceof TFile) {
        //             this.file = file;
        //         }
        //     }
        // }
        
        // if (!this.file) {
        //     return;
        // }
        
        // await this.render();
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
        const noteData = await this.parseNoteFile(arrayBuffer);
        
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        for (const curve of noteData.curves) {
            const halfWidth = (curve.width || 2) / 2;
            for (const point of curve.points) {
                minX = Math.min(minX, point.x - halfWidth);
                minY = Math.min(minY, point.y - halfWidth);
                maxX = Math.max(maxX, point.x + halfWidth);
                maxY = Math.max(maxY, point.y + halfWidth);
            }
        }
        
        let cropLeft = 0;
        let cropTop = 0;
        let cropRight = 0;
        let cropBottom = 0;
        
        if (this.settings.cropToContent) {
            if (isFinite(minX) && isFinite(maxX)) {
                cropLeft = Math.max(0, minX);
                cropRight = Math.max(0, noteData.width - maxX);
            }
            
            if (isFinite(minY) && isFinite(maxY)) {
                cropTop = Math.max(0, minY);
                cropBottom = Math.max(0, noteData.height - maxY);
            }
        }
        
        const croppedWidth = Math.max(1, noteData.width - cropLeft - cropRight);
        const croppedHeight = Math.max(1, noteData.height - cropTop - cropBottom);
        
        canvas.width = croppedWidth;
        canvas.height = croppedHeight;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get canvas context');
        
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.translate(-cropLeft, -cropTop);
        
        for (const curve of noteData.curves) {
            this.drawCurve(ctx, curve);
        }
    }
    
    drawCurve(ctx: CanvasRenderingContext2D, curve: CurveData) {
        if (curve.points.length < 2) return;
        
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = curve.color || 'rgba(0, 0, 0, 1)';
        ctx.lineWidth = Math.max(curve.width || 2, 0.5);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        const points = curve.points.filter(
            p => p && typeof p.x === 'number' && typeof p.y === 'number' && !isNaN(p.x) && !isNaN(p.y)
        );
        
        if (points.length < 2) {
            ctx.restore();
            return;
        }
        
        if (points.length === 2) {
            ctx.moveTo(points[0].x, points[0].y);
            ctx.lineTo(points[1].x, points[1].y);
        } else {
            ctx.moveTo(points[0].x, points[0].y);
            
            for (let i = 1; i < points.length - 1; i++) {
                const prevPoint = points[i - 1];
                const currPoint = points[i];
                const nextPoint = points[i + 1];
                
                const cp1x = (prevPoint.x + currPoint.x) / 2;
                const cp1y = (prevPoint.y + currPoint.y) / 2;
                const cp2x = (currPoint.x + nextPoint.x) / 2;
                const cp2y = (currPoint.y + nextPoint.y) / 2;
                
                ctx.quadraticCurveTo(currPoint.x, currPoint.y, cp2x, cp2y);
            }
            
            const secondLastPoint = points[points.length - 2];
            const lastPoint = points[points.length - 1];
            ctx.quadraticCurveTo(secondLastPoint.x, secondLastPoint.y, lastPoint.x, lastPoint.y);
        }
        
        ctx.stroke();
        ctx.restore();
    }
    
    async parseNoteFile(arrayBuffer: ArrayBuffer): Promise<NotabilityData> {
        const zip = await JSZip.loadAsync(arrayBuffer);
        
        const allFiles = Object.keys(zip.files);
        let sessionPlistFile = null;
        
        for (const fileName of allFiles) {
            const lowerFileName = fileName.toLowerCase();
            if (lowerFileName.endsWith('/session.plist') || lowerFileName === 'session.plist') {
                sessionPlistFile = zip.file(fileName);
                break;
            }
        }
        
        if (!sessionPlistFile) {
            throw new Error(`Session.plist not found in .note file. Available files: ${allFiles.join(', ')}`);
        }
        
        const plistData = await sessionPlistFile.async('arraybuffer');
        const plistObj = this.parseBinaryPlist(plistData);
        
        return this.extractCurveData(plistObj);
    }
    
    plistToPlain(plistValue: any): any {
        if (!plistValue) return plistValue;
        
        if (plistValue.type === 'PLData' || plistValue.constructor?.name === 'PLData' || 
            (plistValue[Symbol.toStringTag] === 'PLData')) {
            if (plistValue.buffer) {
                return plistValue.buffer;
            }
            return plistValue.data || plistValue;
        }
        
        if (plistValue instanceof PLDictionary || (plistValue.type === 'PLDictionary') ||
            (plistValue[Symbol.toStringTag] === 'PLDictionary')) {
            const result: any = {};
            for (const [key, value] of plistValue) {
                const keyStr = this.plistToPlain(key);
                result[keyStr] = this.plistToPlain(value);
            }
            return result;
        }
        
        if (plistValue instanceof Array || (plistValue.type === 'PLArray') ||
            (plistValue[Symbol.toStringTag] === 'PLArray')) {
            return Array.from(plistValue).map(item => this.plistToPlain(item));
        }
        
        if (plistValue.value !== undefined && typeof plistValue.value !== 'object') {
            return plistValue.value;
        }
        
        if (typeof plistValue !== 'object' || plistValue === null) {
            return plistValue;
        }
        
        const tag = plistValue[Symbol.toStringTag];
        if (tag && tag.startsWith('PL')) {
            if (plistValue.data !== undefined) {
                return plistValue.data;
            }
            if (plistValue.value !== undefined) {
                return plistValue.value;
            }
        }
        
        if (plistValue[Symbol.iterator]) {
            const result: any = {};
            try {
                for (const [key, value] of plistValue) {
                    const keyStr = this.plistToPlain(key);
                    result[keyStr] = this.plistToPlain(value);
                }
                return result;
            } catch (e) {
                try {
                    return Array.from(plistValue).map(item => this.plistToPlain(item));
                } catch (e2) {
                }
            }
        }
        
        return plistValue;
    }
    
    parseBinaryPlist(arrayBuffer: ArrayBuffer): any {
        try {
            const result = decode(arrayBuffer);
            
            if (!result || !result.plist) {
                throw new Error('Decode returned empty result');
            }
            
            const plainObject = this.plistToPlain(result.plist);
            
            if (!plainObject) {
                throw new Error('Conversion returned empty object');
            }
            
            return plainObject;
        } catch (error) {
            console.error('Error parsing binary plist:', error);
            console.error('Error stack:', error.stack);
            throw new Error(`Could not parse plist file: ${error.message}`);
        }
    }
    
    extractCurveData(plistObj: any): NotabilityData {
        if (!plistObj || typeof plistObj !== 'object') {
            throw new Error('Invalid plist object');
        }
        
        const searchForCurveData = (obj: any, depth: number = 0, visited: Set<any> = new Set()): any => {
            if (depth > 15) return null; // Prevent infinite recursion
            if (!obj || typeof obj !== 'object') return null;
            
            if (visited.has(obj)) return null;
            visited.add(obj);
            
            if (obj.curvespoints || obj.curvesPoints || obj.CurvesPoints) {
                return obj;
            }
            
            if (Array.isArray(obj)) {
                for (const item of obj) {
                    const result = searchForCurveData(item, depth + 1, visited);
                    if (result) return result;
                }
                return null;
            }
            
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const result = searchForCurveData(obj[key], depth + 1, visited);
                    if (result) return result;
                }
            }
            return null;
        };
        
        const curveData = searchForCurveData(plistObj);
        
        if (!curveData) {
            try {
                const sample = JSON.stringify(plistObj, (key, value) => {
                    if (typeof value === 'object' && value !== null) {
                        const keys = Object.keys(value);
                        if (keys.length > 10) {
                            return `[Object with ${keys.length} keys: ${keys.slice(0, 5).join(', ')}...]`;
                        }
                    }
                    return value;
                }, 2).substring(0, 2000);
                console.error('Plist structure sample:', sample);
            } catch (e) {
                console.error('Could not stringify plist structure');
            }
            throw new Error('No curve data found in plist');
        }
        
        const pointsKey = curveData.curvespoints || curveData.curvesPoints || curveData.CurvesPoints;
        const numPointsKey = curveData.curvesnumpoints || curveData.curvesNumPoints || curveData.CurvesNumPoints;
        const widthsKey = curveData.curveswidth || curveData.curvesWidth || curveData.CurvesWidth;
        const colorsKey = curveData.curvescolors || curveData.curvesColors || curveData.CurvesColors;
        
        const pointsData = this.decodeData(pointsKey, 'float');
        const numPoints = this.decodeData(numPointsKey, 'int');
        const widths = this.decodeData(widthsKey, 'float');
        const colors = this.decodeData(colorsKey, 'int');
        
        if (pointsData.length === 0 || numPoints.length === 0) {
            throw new Error('No valid curve data decoded');
        }
        
        const curves: CurveData[] = [];
        let pointIndex = 0;
        
        for (let i = 0; i < numPoints.length; i++) {
            const numPointsInCurve = numPoints[i];
            if (numPointsInCurve <= 0) continue;
            
            const points = [];
            for (let j = 0; j < numPointsInCurve; j++) {
                const x = pointsData[pointIndex * 2];
                const y = pointsData[pointIndex * 2 + 1];
                
                if (x !== undefined && y !== undefined && !isNaN(x) && !isNaN(y)) {
                    points.push({ x, y });
                }
                pointIndex++;
            }
            
            if (points.length >= 2) {
                const color = this.rgbaIntToColor(colors[i] || 0);
                curves.push({
                    points,
                    width: widths[i] || 2,
                    color
                });
            }
        }
        
        if (curves.length === 0) {
            throw new Error('No valid curves created from data');
        }
        
        let maxX = 0, maxY = 0;
        for (const curve of curves) {
            for (const point of curve.points) {
                maxX = Math.max(maxX, point.x);
                maxY = Math.max(maxY, point.y);
            }
        }
        
        return {
            curves,
            width: Math.max(Math.ceil(maxX) + 50, 800),
            height: Math.max(Math.ceil(maxY) + 50, 1000)
        };
    }
    
    decodeData(data: any, type: 'float' | 'int'): number[] {
        if (!data) return [];
        
        let buffer: ArrayBuffer;
        
        if (data instanceof ArrayBuffer) {
            buffer = data;
        } else if (data instanceof Uint8Array || (typeof Buffer !== 'undefined' && data instanceof Buffer)) {
            buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        } else if (typeof data === 'string') {
            const binary = atob(data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            buffer = bytes.buffer;
        } else if (data.data) {
            return this.decodeData(data.data, type);
        } else {
            return [];
        }
        
        if (type === 'float') {
            return Array.from(new Float32Array(buffer));
        } else {
            return Array.from(new Int32Array(buffer));
        }
    }
    
    rgbaIntToColor(rgba: number): string {
        if (!rgba || rgba === 0) return 'rgba(0, 0, 0, 1)';
        
        const a = (rgba >>> 24) & 0xFF;
        const b = (rgba >>> 16) & 0xFF;
        const g = (rgba >>> 8) & 0xFF;
        const r = rgba & 0xFF;
        
        if (a === 0 && (r > 0 || g > 0 || b > 0)) {
            const r2 = (rgba >>> 24) & 0xFF;
            const g2 = (rgba >>> 16) & 0xFF;
            const b2 = (rgba >>> 8) & 0xFF;
            const a2 = (rgba & 0xFF) / 255;
            return `rgba(${r2}, ${g2}, ${b2}, ${a2})`;
        }
        
        return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
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
