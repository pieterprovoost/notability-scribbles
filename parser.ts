import JSZip from 'jszip';
import { decode, PLDictionary, PLArray, PLData } from '@hqtsm/plist';
import { NotabilityData, CurveData } from './types';

/**
 * Parses a Notability .note file from an ArrayBuffer
 */
export async function parseNoteFile(arrayBuffer: ArrayBuffer): Promise<NotabilityData> {
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
    const plistObj = parseBinaryPlist(plistData);
    
    return extractCurveData(plistObj);
}

/**
 * Converts plist objects to plain JavaScript objects
 */
export function plistToPlain(plistValue: any): any {
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
            const keyStr = plistToPlain(key);
            result[keyStr] = plistToPlain(value);
        }
        return result;
    }
    
    if (plistValue instanceof Array || (plistValue.type === 'PLArray') ||
        (plistValue[Symbol.toStringTag] === 'PLArray')) {
        return Array.from(plistValue).map(item => plistToPlain(item));
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
                const keyStr = plistToPlain(key);
                result[keyStr] = plistToPlain(value);
            }
            return result;
        } catch (e) {
            try {
                return Array.from(plistValue).map(item => plistToPlain(item));
            } catch (e2) {
            }
        }
    }
    
    return plistValue;
}

/**
 * Parses a binary plist file from an ArrayBuffer
 */
export function parseBinaryPlist(arrayBuffer: ArrayBuffer): any {
    try {
        const result = decode(arrayBuffer);
        
        if (!result || !result.plist) {
            throw new Error('Decode returned empty result');
        }
        
        const plainObject = plistToPlain(result.plist);
        
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

/**
 * Extracts curve data from a parsed plist object
 */
export function extractCurveData(plistObj: any): NotabilityData {
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
    
    const pointsData = decodeData(pointsKey, 'float');
    const numPoints = decodeData(numPointsKey, 'int');
    const widths = decodeData(widthsKey, 'float');
    const colors = decodeData(colorsKey, 'int');
    
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
            const color = rgbaIntToColor(colors[i] || 0);
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

/**
 * Decodes binary data to an array of numbers
 */
export function decodeData(data: any, type: 'float' | 'int'): number[] {
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
        return decodeData(data.data, type);
    } else {
        return [];
    }
    
    if (type === 'float') {
        return Array.from(new Float32Array(buffer));
    } else {
        return Array.from(new Int32Array(buffer));
    }
}

/**
 * Converts an RGBA integer to a CSS rgba color string
 */
export function rgbaIntToColor(rgba: number): string {
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
