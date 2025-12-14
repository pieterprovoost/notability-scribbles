export interface CurveData {
    points: Array<{ x: number; y: number }>;
    width: number;
    color: string;
}

export interface NotabilityData {
    curves: CurveData[];
    width: number;
    height: number;
}

export interface NotabilityPluginSettings {
    cropToContent: boolean;
}
