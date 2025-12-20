import { hierarchy, tree as createTree, HierarchyPointNode } from 'd3-hierarchy';
import { select } from 'd3-selection';
import { scaleOrdinal } from 'd3-scale';
import { zoom, zoomIdentity } from 'd3-zoom';
import 'd3-transition';

type ThemeColor = string | { light: string; dark: string };

interface MindMapData {
  name: string;
  children?: MindMapData[];
  color?: ThemeColor;
  labelBackground?: ThemeColor;
  shape?: 'circle' | 'chevron';
  size?: number;
  collapsed?: boolean;
}

interface NodeInfo {
  label: string;
  depth: number;
  data: MindMapData;
}

interface ThemeColors {
  nodeColors: string[];
  linkColor: string;
  textColor: string;
  bgColor: string;
}

type Theme = 'light' | 'dark';

const THEMES: Record<Theme, ThemeColors> = {
  light: {
    nodeColors: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
    linkColor: '#ccc',
    textColor: '#333',
    bgColor: '#fff',
  },
  dark: {
    nodeColors: ['#4dabf7', '#ffa94d', '#69db7c', '#ff6b6b', '#da77f2', '#e599f7', '#fcc2d7', '#adb5bd', '#ffe066', '#66d9e8'],
    linkColor: '#495057',
    textColor: '#e9ecef',
    bgColor: '#1a1a1a',
  }
};

interface Options {
  colorSet?: string[];
  defaultNodeSize?: number;
  theme?: Theme;
  onLabelClick?: (node: NodeInfo) => void;
  onToggleClick?: (node: NodeInfo) => void;
  direction?: 'ltr' | 'rtl';
  nodeShape?: 'circle' | 'chevron';
  chevronSize?: number;
  labelBackground?: string | ((node: NodeInfo) => string);
  labelPadding?: number | { x: number; y: number };
  labelOffset?: number;
  backgroundColor?: string | ((theme: Theme) => string);
}

interface Axis {
  x: number;
  y: number;
}

// MNode: D3 hierarchy node with layout coordinates and toggle state
type MNode = HierarchyPointNode<MindMapData> & {
  x0: number;
  y0: number;
  _children?: MNode[] | null;
  _labelCache?: { key: string; width: number; height: number; x: number; y: number };
};

const LABEL_PADDING_X_DEFAULT = 6;
const LABEL_PADDING_Y_DEFAULT = 3;
const LABEL_RADIUS = 3;
const LABEL_BASE_OFFSET_DEFAULT = 12;
const LABEL_GAP_FROM_SHAPE = 6;
const LABEL_THEME_FALLBACK: Record<Theme, string> = {
  light: '#f8f9fa',
  dark: '#2b2f38'
};

function diagonal(s: Axis, d: Axis) {
  return `M ${s.y} ${s.x}
    C ${(s.y + d.y) / 2} ${s.x},
      ${(s.y + d.y) / 2} ${d.x},
      ${d.y} ${d.x}`;
}

const chevronPath = (size: number, expanded: boolean, dirSign: number) => {
  // Keep chevrons slim to avoid overlapping label backgrounds
  const tipLength = size * 0.6;
  const halfHeight = size * 0.3;
  const tipX = tipLength * (expanded ? -dirSign : dirSign);
  const baseX = -tipX;
  return `M ${baseX} ${-halfHeight} L ${tipX} 0 L ${baseX} ${halfHeight}`;
};

const resolveColor = (color: ThemeColor | undefined, theme: Theme): string | undefined => {
  if (!color) return undefined;
  if (typeof color === 'string') return color;
  return color[theme];
};

export default function getRender(container: HTMLElement, options: Options = {}) {
  const defaultNodeSize = options.defaultNodeSize ?? 4.5;
  const direction: 'ltr' | 'rtl' = options.direction ?? 'ltr';
  let theme: Theme = options.theme || 'light';
  const labelPaddingX = typeof options.labelPadding === 'number'
    ? options.labelPadding
    : options.labelPadding?.x ?? LABEL_PADDING_X_DEFAULT;
  const labelPaddingY = typeof options.labelPadding === 'number'
    ? options.labelPadding
    : options.labelPadding?.y ?? LABEL_PADDING_Y_DEFAULT;
  const labelBaseOffset = options.labelOffset ?? LABEL_BASE_OFFSET_DEFAULT;

  const getBackgroundColor = (): string => {
    const configured = options.backgroundColor;
    if (typeof configured === 'function') {
      return configured(theme);
    }
    return configured ?? THEMES[theme].bgColor;
  };

  const svg = select(container).append('svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .style('overflow', 'scroll')
    .style('background', getBackgroundColor());
  const svgGroup = svg.append('g');

  // Read dimensions dynamically for resize support
  const getDimensions = () => ({
    width: container.clientWidth,
    height: container.clientHeight
  });

  const colorSet = options.colorSet || THEMES[theme].nodeColors;
  const color = scaleOrdinal(colorSet);
  const dirSign = direction === 'rtl' ? -1 : 1;

  let root: MNode | undefined;
  let nodeId = 0;

  const zoomBehavior = zoom<SVGSVGElement, unknown>().on('zoom', ev => {
    svgGroup.attr('transform', ev.transform);
  });
  svg.call(zoomBehavior);

  const getNodeColor = (d: MNode): string =>
    resolveColor(d.data.color, theme) || color(String(d.depth));

  const getNodeSize = (d: MNode): number => d.data.size ?? defaultNodeSize;

  const getNodeShape = (d: MNode): 'circle' | 'chevron' =>
    d.data.shape ?? options.nodeShape ?? 'circle';

  const getChevronSize = (d: MNode): number =>
    options.chevronSize ?? getNodeSize(d) * 2;

  const getLabelBackground = (d: MNode): string => {
    const bgFromData = resolveColor(d.data.labelBackground, theme);
    const configured = options.labelBackground;
    const bgFromOption = typeof configured === 'function'
      ? configured({ label: d.data.name, depth: d.depth, data: d.data })
      : configured;
    return bgFromData ?? bgFromOption ?? LABEL_THEME_FALLBACK[theme];
  };

  const getLabelDx = (d: MNode): number => {
    const hasChildren = !!d.children;
    const side = hasChildren ? -1 : 1;
    const shapeGap = getNodeShape(d) === 'chevron'
      ? Math.max(getChevronSize(d) * 0.6, LABEL_GAP_FROM_SHAPE)
      : getNodeSize(d);
    return side * (labelBaseOffset + shapeGap) * dirSign;
  };

  const getTextAnchor = (d: MNode): 'start' | 'end' => (getLabelDx(d) < 0 ? 'end' : 'start');

  function centerContent(nodes: MNode[], animate = true) {
    if (nodes.length === 0) return;

    const { width } = getDimensions();
    const minY = Math.min(...nodes.map(d => d.y));
    const maxY = Math.max(...nodes.map(d => d.y));
    const treeWidth = maxY - minY;
    const centerX = (width - treeWidth) / 2 - minY;

    const transform = zoomIdentity.translate(centerX, 0);
    if (animate) {
      svg.transition()
        .duration(750)
        .call(zoomBehavior.transform, transform);
    } else {
      svg.call(zoomBehavior.transform, transform);
    }
  }

  function update(source: MNode, animateCenter = true) {
    if (!root) return;

    const { width, height } = getDimensions();
    const tree = createTree<MindMapData>().size([height, width]);
    const treeData = tree(root);
    const nodes = treeData.descendants() as MNode[];
    const links = treeData.links();

    nodes.forEach(d => { d.y = d.depth * 180 * dirSign; });

    const node = svgGroup.selectAll<SVGGElement, MNode>('.node')
      .data(nodes, (d: MNode & { _id?: number }): number => d._id || (d._id = ++nodeId));

    const nodeEnter = node.enter()
      .append('g')
      .attr('class', 'node')
      .attr('transform', () => `translate(${source.y0}, ${source.x0})`);

    nodeEnter.append('circle')
      .attr('class', 'circle')
      .attr('r', 1e-6)
      .style('fill', d => color(String(d.depth)))
      .style('cursor', 'pointer')
      .style('stroke', '#fff')
      .style('stroke-width', '1.5px');

    nodeEnter.append('circle')
      .attr('class', 'chevron-hit')
      .attr('r', d => getChevronSize(d) * 0.8)
      .style('fill', 'transparent')
      .style('pointer-events', 'all')
      .style('cursor', 'pointer')
      .style('display', 'none');

    nodeEnter.append('path')
      .attr('class', 'chevron')
      .attr('d', d => chevronPath(getChevronSize(d), !!d.children, dirSign))
      .style('fill', 'none')
      .style('stroke', d => getNodeColor(d))
      .style('stroke-width', '1.5px')
      .style('stroke-linecap', 'round')
      .style('stroke-linejoin', 'round')
      .style('pointer-events', 'none')
      .style('display', 'none');

    const labelEnter = nodeEnter.append('g')
      .attr('class', 'label');

    labelEnter.append('rect')
      .attr('rx', LABEL_RADIUS)
      .attr('ry', LABEL_RADIUS)
      .attr('fill', 'transparent')
      .style('pointer-events', 'none');

    labelEnter.append('text')
      .attr('dx', getLabelDx)
      .attr('dy', 3)
      .style('text-anchor', getTextAnchor)
      .style('font-size', '10px')
      .style('font-family', 'sans-serif')
      .style('cursor', 'pointer')
      .text(d => d.data.name);

    const nodeUpdate = nodeEnter.merge(node);

    nodeUpdate.transition()
      .duration(750)
      .attr('transform', d => `translate(${d.y}, ${d.x})`);

    nodeUpdate.select<SVGCircleElement>('circle.circle')
      .style('display', d => getNodeShape(d) === 'circle' ? null : 'none')
      .attr('r', getNodeSize)
      .style('fill', getNodeColor)
      .on('click', nodeClicked);

    nodeUpdate.select<SVGCircleElement>('.chevron-hit')
      .style('display', d => getNodeShape(d) === 'chevron' ? null : 'none')
      .attr('r', d => getChevronSize(d) * 0.8)
      .on('click', nodeClicked);

    nodeUpdate.select<SVGPathElement>('.chevron')
      .style('display', d => getNodeShape(d) === 'chevron' ? null : 'none')
      .attr('d', d => chevronPath(getChevronSize(d), !!d.children, dirSign))
      .style('stroke', getNodeColor);

    const labelUpdate = nodeUpdate.select<SVGGElement>('.label');

    labelUpdate.select<SVGTextElement>('text')
      .attr('dx', getLabelDx)
      .attr('dy', 3)
      .style('text-anchor', getTextAnchor)
      .style('fill', THEMES[theme].textColor)
      .style('cursor', 'pointer')
      .text(d => d.data.name)
      .on('click', labelClicked)
      .each(function (d) {
        const textEl = this as SVGTextElement;
        const key = `${d.data.name}-${getTextAnchor(d)}-${getLabelDx(d)}`;
        if (!d._labelCache || d._labelCache.key !== key) {
          let box = { x: 0, y: 0, width: 0, height: 0 };
          try {
            box = textEl.getBBox();
          } catch (e) {
            // Fallback if getBBox fails (element not rendered yet)
            const textLength = textEl.getComputedTextLength?.() ?? (textEl.textContent?.length ?? 0) * 6;
            box = { x: 0, y: -5, width: textLength, height: 10 };
          }
          d._labelCache = { key, width: box.width, height: box.height, x: box.x, y: box.y };
        }
        const box = d._labelCache;
        const rect = select(textEl.parentNode as SVGGElement).select<SVGRectElement>('rect');
        rect
          .attr('x', box.x - labelPaddingX)
          .attr('y', box.y - labelPaddingY)
          .attr('width', box.width + labelPaddingX * 2)
          .attr('height', box.height + labelPaddingY * 2)
          .attr('rx', LABEL_RADIUS)
          .attr('ry', LABEL_RADIUS)
          .attr('fill', getLabelBackground(d));
      });

    const nodeExit = node.exit()
      .transition()
      .duration(750)
      .attr('transform', () => `translate(${source.y}, ${source.x})`)
      .remove();

    nodeExit.select('circle.circle').attr('r', 1e-6);
    nodeExit.select('.chevron-hit').attr('r', 1e-6);
    nodeExit.select('.chevron').style('stroke-opacity', 1e-6);
    nodeExit.select('.label').style('opacity', 1e-6);

    const link = svgGroup.selectAll<SVGPathElement, typeof links[0]>('.link')
      .data(links, d => (d.target as MNode & { _id?: number })._id!);

    const linkEnter = link.enter().insert('path', 'g')
      .attr('class', 'link')
      .attr('d', () => {
        const o = { x: source.x0, y: source.y0 };
        return diagonal(o, o);
      })
      .style('fill', 'none')
      .style('stroke', THEMES[theme].linkColor)
      .style('stroke-width', '1.5px');

    linkEnter.merge(link)
      .transition()
      .duration(750)
      .attr('d', d => diagonal(d.source as Axis, d.target as Axis));

    link.exit().transition()
      .duration(750)
      .attr('d', () => {
        const o = { x: source.x, y: source.y };
        return diagonal(o, o);
      })
      .remove();

    nodes.forEach(d => {
      d.x0 = d.x;
      d.y0 = d.y;
    });

    // Center content after layout update
    centerContent(nodes, animateCenter);

    function nodeClicked(event: MouseEvent, d: MNode) {
      event.stopPropagation();
      if (d.children) {
        d._children = d.children as MNode[];
        d.children = undefined;
      } else {
        d.children = (d._children as MNode[]) ?? undefined;
        d._children = null;
      }
      update(d);
      options.onToggleClick?.({ label: d.data.name, depth: d.depth, data: d.data });
    }

    function labelClicked(event: MouseEvent, d: MNode) {
      event.stopPropagation();
      if (d.children) {
        d._children = d.children as MNode[];
        d.children = undefined;
      } else {
        d.children = (d._children as MNode[]) ?? undefined;
        d._children = null;
      }
      update(d);
      options.onLabelClick?.({ label: d.data.name, depth: d.depth, data: d.data });
    }
  }

  function applyCollapsedStates(node: MNode) {
    if (node.children) {
      (node.children as MNode[]).forEach(applyCollapsedStates);
      if (node.data.collapsed) {
        node._children = node.children as MNode[];
        node.children = undefined;
      }
    }
  }

  function setTheme(newTheme: Theme) {
    theme = newTheme;
    svg.style('background', getBackgroundColor());
    svgGroup.selectAll('.link').style('stroke', THEMES[theme].linkColor);
    svgGroup.selectAll('.node text').style('fill', THEMES[theme].textColor);
    const nodes = svgGroup.selectAll<SVGGElement, MNode>('.node');
    nodes.select<SVGCircleElement>('circle.circle')
      .style('display', d => getNodeShape(d) === 'circle' ? null : 'none')
      .style('fill', getNodeColor);
    nodes.select<SVGCircleElement>('circle.chevron-hit')
      .style('display', d => getNodeShape(d) === 'chevron' ? null : 'none');
    nodes.select<SVGPathElement>('path.chevron')
      .style('display', d => getNodeShape(d) === 'chevron' ? null : 'none')
      .style('stroke', getNodeColor);
    nodes.select<SVGRectElement>('g.label rect').attr('fill', getLabelBackground);
  }

  function resize() {
    if (root) update(root);
  }

  return function (data: MindMapData) {
    const { height } = getDimensions();
    root = hierarchy(data) as unknown as MNode;
    root.x0 = height / 2;
    root.y0 = 0;
    applyCollapsedStates(root);
    update(root, false);

    return { root, svg, svgGroup, setTheme, resize };
  };
}
