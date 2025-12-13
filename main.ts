import { Plugin, TFile, ItemView, WorkspaceLeaf } from 'obsidian';
import JSZip from 'jszip';
import { parseBuffer } from 'bplist-parser';

const VIEW_TYPE_NOTABILITY = 'notability-view';

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

class NotabilityView extends ItemView {
    file: TFile | null;
    
    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
        this.file = null;
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
        
        if (!this.file) {
            return;
        }
        
        await this.render();
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
            cls: 'notability-loading',
            // text: 'Loading Notability file...'
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
        
        console.log(`Rendering file: ${this.file.path}`);
        
        const arrayBuffer = await this.app.vault.readBinary(this.file);
        const noteData = await this.parseNoteFile(arrayBuffer);
        
        canvas.width = noteData.width;
        canvas.height = noteData.height;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get canvas context');
        
        // Enable image smoothing for better rendering quality
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
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
    
    parseBinaryPlist(arrayBuffer: ArrayBuffer): any {
        try {
            const buffer = Buffer.from(arrayBuffer);
            const result = parseBuffer(buffer);
            return result[0];
        } catch (error) {
            console.error('Error parsing binary plist:', error);
            throw new Error(`Could not parse plist file: ${error.message}`);
        }
    }
    
    extractCurveData(plistObj: any): NotabilityData {
        const objects = plistObj.$objects || plistObj.objects || [];
        
        let curveData: any = null;
        
        for (const obj of objects) {
            if (obj && typeof obj === 'object') {
                if (obj.curvespoints || obj.curvesPoints || obj.CurvesPoints) {
                    curveData = obj;
                    break;
                }
            }
        }
        
        // if (!curveData) {
        //     const searchForCurveData = (obj: any, depth: number = 0): any => {
        //         if (depth > 10) return null;
        //         if (!obj || typeof obj !== 'object') return null;
                
        //         if (obj.curvespoints || obj.curvesPoints || obj.CurvesPoints) {
        //             return obj;
        //         }
                
        //         for (const key in obj) {
        //             if (obj.hasOwnProperty(key)) {
        //                 const result = searchForCurveData(obj[key], depth + 1);
        //                 if (result) return result;
        //             }
        //         }
        //         return null;
        //     };
            
        //     curveData = searchForCurveData(plistObj);
        // }
        
        if (!curveData) {
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
        } else if (data instanceof Buffer) {
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
    
    async onClose() {
    }
}

export default class NotabilityPlugin extends Plugin {
    async onload() {
        this.registerView(
            VIEW_TYPE_NOTABILITY,
            (leaf) => new NotabilityView(leaf)
        );
        
        this.registerExtensions(['note'], VIEW_TYPE_NOTABILITY);
    }
    
    onunload() {
    }
}
