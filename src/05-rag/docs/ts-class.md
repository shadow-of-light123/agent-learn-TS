## 来源

摘自《TypeScript 教程》，作者阮一峰，仅供个人学习使用。
原文：https://github.com/wangdoc/typescript-tutorial

---

# TypeScript 的 class 类型

## 简介

类（class）是面向对象编程的基本构件，封装了属性和方法，TypeScript 给予了全面支持。

### 属性的类型

类的属性可以在顶层声明，也可以在构造方法内部声明。

对于顶层声明的属性，可以在声明时同时给出类型。

```typescript
class Point {
  x:number;
  y:number;
}
```

上面声明中，属性`x`和`y`的类型都是`number`。

如果不给出类型，TypeScript 会认为`x`和`y`的类型都是`any`。

```typescript
class Point {
  x;
  y;
}
```

上面示例中，`x`和`y`的类型都是`any`。

如果声明时给出初值，可以不写类型，TypeScript 会自行推断属性的类型。

```typescript
class Point {
  x = 0;
  y = 0;
}
```

上面示例中，属性`x`和`y`的类型都会被推断为 number。

TypeScript 有一个配置项`strictPropertyInitialization`，只要打开（默认是打开的），就会检查属性是否设置了初值，如果没有就报错。

```typescript
// 打开 strictPropertyInitialization
class Point {
  x: number; // 报错
  y: number; // 报错
}
```

上面示例中，如果类的顶层属性不赋值，就会报错。如果不希望出现报错，可以使用非空断言。

```typescript
class Point {
  x!: number;
  y!: number;
}
```

上面示例中，属性`x`和`y`没有初值，但是属性名后面添加了感叹号，表示这两个属性肯定不会为空，所以 TypeScript 就不报错了，详见《类型断言》一章。

