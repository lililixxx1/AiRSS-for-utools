export function categoryList(): Promise<string[]>;
export function applyAi(itemDoc: any, ai: any, source: any): Promise<any>;
export function markError(itemId: any): Promise<void>;
export function applyTrans(itemDoc: any, paras: any, texts: any, model: any): Promise<{
    item: any;
    aiTrans: {
        paras: {
            idx: any;
            head: string;
            text: any;
        }[];
        at: number;
        model: any;
    };
}>;
export function applyToc(itemDoc: any, paras: any, sections: any, model: any): Promise<{
    item: any;
    aiToc: {
        sections: {
            title: string;
            idx: any;
            head: string;
            level: number;
        }[];
        at: number;
        model: any;
    };
}>;
export function supersededByExtract(itemId: any, startedAt: any): Promise<boolean>;
