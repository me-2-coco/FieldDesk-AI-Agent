function Home(){

return(

<div className="page home-page">


{/* 今日维修 */}

<div className="card">


<h2>
今日维修
</h2>


<div className="stats-row">


<div>

<div>
待维修
</div>

<strong>
3
</strong>

</div>



<div>

<div>
维修中
</div>

<strong>
5
</strong>

</div>



<div>

<div>
已完成
</div>

<strong>
12
</strong>

</div>


</div>


</div>





{/* 个人库存 */}

<div className="card">


<h2>
个人配件库存
</h2>



<div className="inventory-item">

<span>
电池
</span>

<b>
2
</b>

</div>



<div className="inventory-item">

<span>
主刷
</span>

<b>
5
</b>

</div>



<div className="inventory-item">

<span>
滤网
</span>

<b>
8
</b>

</div>



<button
className="primary-btn"
>

查看库存

</button>



</div>







{/* 待处理任务 */}

<div className="card">


<h2>
待处理任务
</h2>



<div className="task-summary">


<p>

待维修机器：

<strong>
3
</strong>

台

</p>



<p>

待确认配件：

<strong>
2
</strong>

个

</p>



<p>

异常提醒：

<strong>
1
</strong>

条

</p>



</div>



<button

className="primary-btn"

>

进入维修任务

</button>



</div>





</div>


)

}


export default Home