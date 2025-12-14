import { NotabilityData, CurveData, NotabilityPluginSettings } from './types';

/**
 * Renders Notability data to a canvas element
 */
export async function renderNotabilityFile(
    canvas: HTMLCanvasElement,
    noteData: NotabilityData,
    settings: NotabilityPluginSettings
): Promise<void> {
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
    
    if (settings.cropToContent) {
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
        drawCurve(ctx, curve);
    }
}

/**
 * Draws a single curve on the canvas context
 */
export function drawCurve(ctx: CanvasRenderingContext2D, curve: CurveData): void {
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
